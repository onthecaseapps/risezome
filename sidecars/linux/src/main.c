/*
 * upwell-sidecar-linux
 *
 * Captures 16 kHz mono Int16LE PCM from the local PulseAudio / PipeWire
 * source named by the --device argument (default: server's default source,
 * typically the active output's monitor when invoked with PULSE_SOURCE set
 * by the daemon), and emits framed audio to stdout per the U3 wire protocol:
 *
 *   stdout per 20 ms frame (640 bytes of PCM): [role tag u8][len u32 BE][PCM bytes]
 *   stderr: newline-delimited JSON control messages
 *   stdin:  first line is `{"type":"nonce","nonce":"<hex>"}`; subsequent lines
 *           are tolerated but ignored — the daemon kills via SIGTERM.
 *
 * Build: see ../Makefile
 *
 * Dependencies: libpulse-simple, libpulse (Ubuntu: libpulse-dev).
 */

#include <errno.h>
#include <getopt.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <pulse/simple.h>
#include <pulse/error.h>

#define UPWELL_SIDECAR_VERSION "0.1.0-linux"
#define UPWELL_SAMPLE_RATE 16000
#define UPWELL_FRAME_SAMPLES 320  /* 20 ms @ 16 kHz */
#define UPWELL_FRAME_BYTES (UPWELL_FRAME_SAMPLES * sizeof(int16_t))
#define UPWELL_NONCE_MAX 256
#define UPWELL_INPUT_BUF_MAX 1024

#define ROLE_LOCAL_SYSTEM 0x00
#define ROLE_LOCAL_MIC    0x01

static volatile sig_atomic_t g_stop_requested = 0;

static void on_signal(int signo) {
    (void)signo;
    g_stop_requested = 1;
}

static void install_signal_handlers(void) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    /* Ignore SIGPIPE so a closed stdout doesn't kill us before we surface
     * the failure on stderr. */
    signal(SIGPIPE, SIG_IGN);
}

/*
 * Minimal JSON-string-value extractor. Locates `"key":"value"` in a flat
 * object and copies the unescaped value into out (truncating if needed).
 * Returns 1 on success, 0 on miss. Sufficient for the daemon-controlled
 * input shapes; not a general JSON parser.
 */
static int extract_json_string_field(const char *line, const char *key,
                                     char *out, size_t out_cap) {
    if (out_cap == 0) return 0;
    out[0] = '\0';
    char needle[64];
    int written = snprintf(needle, sizeof(needle), "\"%s\"", key);
    if (written <= 0 || (size_t)written >= sizeof(needle)) return 0;
    const char *p = strstr(line, needle);
    if (p == NULL) return 0;
    p += (size_t)written;
    /* Skip whitespace and the colon. */
    while (*p == ' ' || *p == '\t') p++;
    if (*p != ':') return 0;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '"') return 0;
    p++;
    size_t i = 0;
    while (*p != '\0' && *p != '"' && i + 1 < out_cap) {
        if (*p == '\\' && *(p + 1) != '\0') {
            /* For our use we only expect plain hex, but tolerate simple escapes. */
            char esc = *(p + 1);
            char unescaped;
            switch (esc) {
                case '\\': unescaped = '\\'; break;
                case '"':  unescaped = '"'; break;
                case 'n':  unescaped = '\n'; break;
                case 't':  unescaped = '\t'; break;
                case 'r':  unescaped = '\r'; break;
                default:   unescaped = esc; break;
            }
            out[i++] = unescaped;
            p += 2;
            continue;
        }
        out[i++] = *p++;
    }
    out[i] = '\0';
    return (*p == '"') ? 1 : 0;
}

static int read_line(int fd, char *buf, size_t buf_cap) {
    size_t i = 0;
    while (i + 1 < buf_cap) {
        char c;
        ssize_t r = read(fd, &c, 1);
        if (r == 0) {
            if (i == 0) return 0;
            break;
        }
        if (r < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (c == '\n') break;
        buf[i++] = c;
    }
    buf[i] = '\0';
    return (int)i;
}

static void emit_json_control(const char *json) {
    /* Write to stderr is line-buffered by default for tty; force flush. */
    fputs(json, stderr);
    fputc('\n', stderr);
    fflush(stderr);
}

static void emit_hello(const char *nonce_echo) {
    char buf[UPWELL_NONCE_MAX + 128];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"hello\",\"sidecarVersion\":\"%s\",\"nonceEcho\":\"%s\"}",
             UPWELL_SIDECAR_VERSION, nonce_echo);
    emit_json_control(buf);
}

static void emit_started(const char *device) {
    char buf[512];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"started\",\"device\":\"%s\",\"sampleRate\":%d}",
             device, UPWELL_SAMPLE_RATE);
    emit_json_control(buf);
}

static void emit_permission_denied(const char *reason) {
    char buf[512];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"permission-denied\",\"reason\":\"%s\"}", reason);
    emit_json_control(buf);
}

static void emit_error(const char *code, const char *message) {
    char buf[512];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"error\",\"code\":\"%s\",\"message\":\"%s\"}", code, message);
    emit_json_control(buf);
}

static void emit_stopped(void) {
    emit_json_control("{\"type\":\"stopped\"}");
}

static int write_full(int fd, const void *buf, size_t len) {
    const uint8_t *p = (const uint8_t *)buf;
    size_t off = 0;
    while (off < len) {
        ssize_t w = write(fd, p + off, len - off);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        off += (size_t)w;
    }
    return 0;
}

static int write_frame(uint8_t role_tag, const int16_t *samples, size_t sample_count) {
    uint8_t header[5];
    header[0] = role_tag;
    uint32_t payload_bytes = (uint32_t)(sample_count * sizeof(int16_t));
    header[1] = (uint8_t)((payload_bytes >> 24) & 0xff);
    header[2] = (uint8_t)((payload_bytes >> 16) & 0xff);
    header[3] = (uint8_t)((payload_bytes >> 8) & 0xff);
    header[4] = (uint8_t)(payload_bytes & 0xff);
    if (write_full(STDOUT_FILENO, header, sizeof(header)) != 0) return -1;
    if (write_full(STDOUT_FILENO, samples, payload_bytes) != 0) return -1;
    return 0;
}

static void usage(FILE *out) {
    fprintf(out,
            "Usage: upwell-sidecar-linux [--role=system|mic] [--device=NAME]\n"
            "\n"
            "Reads `{\"type\":\"nonce\",\"nonce\":\"<hex>\"}` from stdin, echoes\n"
            "`{\"type\":\"hello\",\"nonceEcho\":\"<hex>\"}` on stderr, then streams\n"
            "16 kHz mono Int16LE PCM frames on stdout per the U3 wire protocol.\n");
}

int main(int argc, char **argv) {
    const char *role_arg = "system";
    const char *device_name = NULL;

    static struct option long_options[] = {
        {"role",   required_argument, 0, 'r'},
        {"device", required_argument, 0, 'd'},
        {"help",   no_argument,       0, 'h'},
        {0, 0, 0, 0},
    };
    int opt;
    int idx = 0;
    while ((opt = getopt_long(argc, argv, "r:d:h", long_options, &idx)) != -1) {
        switch (opt) {
            case 'r':
                role_arg = optarg;
                break;
            case 'd':
                device_name = optarg;
                break;
            case 'h':
                usage(stdout);
                return 0;
            default:
                usage(stderr);
                return 2;
        }
    }

    uint8_t role_tag;
    if (strcmp(role_arg, "system") == 0) {
        role_tag = ROLE_LOCAL_SYSTEM;
    } else if (strcmp(role_arg, "mic") == 0) {
        role_tag = ROLE_LOCAL_MIC;
    } else {
        fprintf(stderr, "Unknown role: %s\n", role_arg);
        return 2;
    }

    install_signal_handlers();

    /* Step 1: read the nonce line. */
    char input_line[UPWELL_INPUT_BUF_MAX];
    int read_n = read_line(STDIN_FILENO, input_line, sizeof(input_line));
    if (read_n <= 0) {
        emit_error("no-nonce", "stdin closed before nonce was sent");
        return 1;
    }
    char nonce[UPWELL_NONCE_MAX];
    if (!extract_json_string_field(input_line, "nonce", nonce, sizeof(nonce))) {
        emit_error("bad-nonce", "could not parse nonce from stdin");
        return 1;
    }
    emit_hello(nonce);

    /* Step 2: open the capture stream. */
    pa_sample_spec ss;
    ss.format = PA_SAMPLE_S16LE;
    ss.rate = UPWELL_SAMPLE_RATE;
    ss.channels = 1;

    int pa_err = 0;
    pa_simple *s = pa_simple_new(
        NULL,                       /* default server */
        "upwell-sidecar",
        PA_STREAM_RECORD,
        device_name,                /* NULL → default source */
        role_tag == ROLE_LOCAL_MIC ? "upwell-mic" : "upwell-system",
        &ss,
        NULL,                       /* default channel map */
        NULL,                       /* default buffering */
        &pa_err);
    if (s == NULL) {
        const char *err_str = pa_strerror(pa_err);
        if (pa_err == PA_ERR_ACCESS) {
            emit_permission_denied(err_str != NULL ? err_str : "PulseAudio access denied");
        } else {
            emit_error("pa-open-failed", err_str != NULL ? err_str : "unknown");
        }
        return 1;
    }
    emit_started(device_name != NULL ? device_name : "default");

    /* Step 3: capture loop. */
    int16_t frame[UPWELL_FRAME_SAMPLES];
    while (!g_stop_requested) {
        if (pa_simple_read(s, frame, sizeof(frame), &pa_err) < 0) {
            const char *err_str = pa_strerror(pa_err);
            emit_error("pa-read-failed", err_str != NULL ? err_str : "unknown");
            break;
        }
        if (write_frame(role_tag, frame, UPWELL_FRAME_SAMPLES) != 0) {
            /* Stdout closed (parent gone). Exit quietly. */
            break;
        }
    }

    pa_simple_free(s);
    emit_stopped();
    return 0;
}
