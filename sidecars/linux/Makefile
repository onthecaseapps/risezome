CC      ?= gcc
CFLAGS  ?= -Wall -Wextra -Wpedantic -Werror -O2 -std=c11
LDFLAGS ?=
LIBS    := $(shell pkg-config --libs libpulse-simple libpulse 2>/dev/null || echo "-lpulse-simple -lpulse")
INCLUDES := $(shell pkg-config --cflags libpulse-simple libpulse 2>/dev/null || echo "")

OUT_DIR := build
BIN     := $(OUT_DIR)/risezome-sidecar-linux

.PHONY: all clean check-deps

all: $(BIN)

$(OUT_DIR):
	mkdir -p $(OUT_DIR)

$(BIN): src/main.c | $(OUT_DIR)
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $< $(LDFLAGS) $(LIBS)

clean:
	rm -rf $(OUT_DIR)

check-deps:
	@pkg-config --exists libpulse-simple libpulse \
		|| (echo "Missing libpulse-simple/libpulse. On Debian/Ubuntu: sudo apt install libpulse-dev pkg-config build-essential" && exit 1)
	@echo "libpulse + libpulse-simple OK"
