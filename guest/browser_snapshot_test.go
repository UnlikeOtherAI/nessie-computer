package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestCommonSnapshotRealChromiumEditableAX(t *testing.T) {
	payload, err := os.ReadFile("testdata/editable-ax.json")
	if err != nil {
		t.Fatal(err)
	}
	var tree struct {
		Nodes []snapshotAXNode `json:"nodes"`
	}
	if err := json.Unmarshal(payload, &tree); err != nil {
		t.Fatal(err)
	}
	metadata := accessibilitySnapshotMetadata(tree.Nodes)
	names := []string{}
	raw := []string{}
	for _, node := range tree.Nodes {
		raw = append(raw, node.Name.Value)
		projection := metadata[node.NodeID]
		if projection.excluded {
			continue
		}
		name := node.Name.Value
		if projection.name != nil {
			name = *projection.name
		}
		names = append(names, name)
	}
	for _, marker := range []string{"input-secret-marker", "textarea-secret-marker", "editor-secret-marker", "unlabelled-editor-secret-marker", "related-editor-secret-marker"} {
		if !strings.Contains(strings.Join(raw, "\n"), marker) {
			t.Fatalf("fixture does not reproduce %s", marker)
		}
		if strings.Contains(strings.Join(names, "\n"), marker) {
			t.Fatalf("common name leaks %s", marker)
		}
	}
	for _, label := range []string{"Input label", "Textarea label", "Editor label", "Password label", "Public explanation", "Public partial", "Continue"} {
		found := false
		for _, name := range names {
			if name == label {
				found = true
			}
		}
		if !found {
			t.Fatalf("safe name missing: %s", label)
		}
	}
}

func TestSnapshotAncestryAndNameSources(t *testing.T) {
	var nodes []snapshotAXNode
	err := json.Unmarshal([]byte(`[
 {"nodeId":"editor","parentId":"contents","backendDOMNodeId":5,"role":{"value":"generic"},"properties":[{"name":"editable","value":{"value":"richtext"}}],"name":{"value":"Label","sources":[{"type":"attribute","value":{"value":"Label"}}]}},
 {"nodeId":"middle","parentId":"editor"},
 {"nodeId":"text","parentId":"middle","backendDOMNodeId":7,"role":{"value":"StaticText"},"name":{"value":"private"}},
 {"nodeId":"contents","name":{"value":"private","sources":[{"type":"contents","value":{"value":"private"}}]}},
 {"nodeId":"related","name":{"value":"private","sources":[{"type":"relatedElement","value":{"value":"private"},"attributeValue":{"relatedNodes":[{"backendDOMNodeId":7}]}}]}}
 ]`), &nodes)
	if err != nil {
		t.Fatal(err)
	}
	metadata := accessibilitySnapshotMetadata(nodes)
	if !metadata["text"].excluded {
		t.Fatal("missing DOM id severed editing ancestry")
	}
	for _, id := range []string{"contents", "related"} {
		if metadata[id].name == nil || *metadata[id].name != "" {
			t.Fatalf("derived name survived: %s", id)
		}
	}
	if metadata["editor"].name != nil {
		t.Fatal("explicit label was suppressed")
	}
}

func TestSnapshotDerivedLabelOmitsNestedEditor(t *testing.T) {
	var nodes []snapshotAXNode
	err := json.Unmarshal([]byte(`[
 {"nodeId":"wrapper","backendDOMNodeId":40},
 {"nodeId":"label","parentId":"wrapper","role":{"value":"StaticText"},"name":{"value":"Public partial"}},
 {"nodeId":"editor","parentId":"wrapper","role":{"value":"textbox"}},
 {"nodeId":"private","parentId":"editor","role":{"value":"StaticText"},"name":{"value":"private"}},
 {"nodeId":"button","name":{"value":"Public partial private","sources":[{"type":"relatedElement","value":{"value":"Public partial private"},"attributeValue":{"relatedNodes":[{"backendDOMNodeId":40}]}}]}}
 ]`), &nodes)
	if err != nil {
		t.Fatal(err)
	}
	metadata := accessibilitySnapshotMetadata(nodes)
	if metadata["button"].name == nil || *metadata["button"].name != "Public partial" {
		t.Fatal("derived public label was not projected")
	}
	if !metadata["private"].excluded {
		t.Fatal("editor text was not excluded")
	}
}
