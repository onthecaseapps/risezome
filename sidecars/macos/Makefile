SWIFTC   ?= swiftc
SWIFTFLAGS ?= -O
FRAMEWORKS := -framework Foundation -framework AVFoundation -framework CoreAudio -framework AudioToolbox

OUT_DIR := build
BIN     := $(OUT_DIR)/risezome-sidecar-macos

.PHONY: all clean check-deps

all: $(BIN)

$(OUT_DIR):
	mkdir -p $(OUT_DIR)

$(BIN): src/main.swift | $(OUT_DIR)
	$(SWIFTC) $(SWIFTFLAGS) $(FRAMEWORKS) -o $@ $<

clean:
	rm -rf $(OUT_DIR)

check-deps:
	@command -v $(SWIFTC) >/dev/null 2>&1 \
		|| (echo "Missing swiftc. Install Xcode command-line tools: xcode-select --install" && exit 1)
	@echo "swiftc OK ($$($(SWIFTC) --version | head -1))"
	@command -v brew >/dev/null 2>&1 && (brew list blackhole-2ch >/dev/null 2>&1 \
		&& echo "BlackHole OK" \
		|| echo "Note: BlackHole not installed — needed for --role=system. Run: brew install blackhole-2ch") \
		|| echo "Note: install BlackHole for system-audio capture (brew install blackhole-2ch)"
