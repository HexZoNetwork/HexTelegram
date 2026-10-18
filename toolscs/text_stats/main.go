package main

import (
	"fmt"
	"strings"

	"github.com/HexZoNetwork/htsdk/toolscs"
)

func main() {
	toolscs.Main(toolscs.Tool{
		Name:        "text_stats",
		Description: "Count lines, words, characters and bytes of a text. Example custom Go tool - copy this directory to build your own.",
		Input: []toolscs.Input{
			{Name: "text", Type: "string", Description: "the text to measure", Required: true},
		},
		Run: func(a toolscs.Args) (string, error) {
			text := a.Str("text")
			words := len(strings.Fields(text))
			lines := 0
			if text != "" {
				lines = len(strings.Split(strings.TrimRight(text, "\n"), "\n"))
			}
			return fmt.Sprintf("lines=%d words=%d chars=%d bytes=%d", lines, words, len([]rune(text)), len(text)), nil
		},
	})
}
