package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestCodexFixtureSamplesRoundTripThroughGeneratedCodec(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "..", "fixtures", "codex", "samples", "*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(paths)
	if len(paths) == 0 {
		t.Fatal("no Codex fixture samples found")
	}

	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			file, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()

			scanner := bufio.NewScanner(file)
			line := 0
			for scanner.Scan() {
				line++
				input := bytes.TrimSpace(scanner.Bytes())
				if len(input) == 0 {
					continue
				}
				envelope, err := DecodeCodexFixtureEnvelope(input)
				if err != nil {
					t.Fatalf("line %d: decode: %v", line, err)
				}
				encoded, err := EncodeCodexFixtureEnvelope(envelope)
				if err != nil {
					t.Fatalf("line %d: encode: %v", line, err)
				}

				var want any
				var got any
				if err := json.Unmarshal(input, &want); err != nil {
					t.Fatalf("line %d: decode source JSON: %v", line, err)
				}
				if err := json.Unmarshal(encoded, &got); err != nil {
					t.Fatalf("line %d: decode encoded JSON: %v", line, err)
				}
				if !jsonEqual(want, got) {
					t.Fatalf("line %d: encoded envelope changed fields", line)
				}
			}
			if err := scanner.Err(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func jsonEqual(left, right any) bool {
	leftBytes, err := json.Marshal(left)
	if err != nil {
		return false
	}
	rightBytes, err := json.Marshal(right)
	if err != nil {
		return false
	}
	return bytes.Equal(leftBytes, rightBytes)
}
