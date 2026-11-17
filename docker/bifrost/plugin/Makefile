# Builds the billing gate as a Go plugin .so, per the pinned Bifrost release's
# docs/plugins/writing-go-plugin.mdx. The toolchain and the `-buildmode=plugin` flag are not
# optional: a plugin built with any other Go version, or built as ordinary Go code, is refused
# by Bifrost at load time. Cross-compilation does not work for Go plugins either — build on the
# platform the gateway image runs on, or in a container of the same base image.

PLUGIN_NAME := openbot-billing-gate
OUTPUT_DIR  := build

ifeq ($(shell uname),Darwin)
PLUGIN_EXT := .dylib
else
PLUGIN_EXT := .so
endif

OUTPUT := $(OUTPUT_DIR)/$(PLUGIN_NAME)$(PLUGIN_EXT)

.PHONY: build clean vet

build: $(OUTPUT)

$(OUTPUT):
	go build -buildmode=plugin -o $(OUTPUT) main.go

vet:
	go vet ./...

clean:
	rm -rf $(OUTPUT_DIR)
