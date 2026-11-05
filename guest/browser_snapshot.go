package main

import "strings"

// AX hierarchy and name provenance stay private to the observation projection.
// Compute this against the entire tree before applying node or text bounds.
type snapshotAXValue struct {
	Value        string `json:"value"`
	RelatedNodes []struct {
		BackendDOMNodeID int `json:"backendDOMNodeId"`
	} `json:"relatedNodes"`
}
type snapshotAXName struct {
	Value   string `json:"value"`
	Sources []struct {
		Type              string           `json:"type"`
		Superseded        bool             `json:"superseded"`
		Value             *snapshotAXValue `json:"value"`
		AttributeValue    *snapshotAXValue `json:"attributeValue"`
		NativeSourceValue *snapshotAXValue `json:"nativeSourceValue"`
	} `json:"sources"`
}
type snapshotAXNode struct {
	NodeID           string          `json:"nodeId"`
	ParentID         string          `json:"parentId"`
	BackendDOMNodeID int             `json:"backendDOMNodeId"`
	Name             snapshotAXName  `json:"name"`
	Role             snapshotAXValue `json:"role"`
	Value            snapshotAXValue `json:"value"`
	Properties       []struct {
		Name  string `json:"name"`
		Value struct {
			Value any `json:"value"`
		} `json:"value"`
	} `json:"properties"`
}
type snapshotAXMetadata struct {
	excluded bool
	name     *string
}

func snapshotEditable(node snapshotAXNode) bool {
	if node.Role.Value == "textbox" {
		return true
	}
	for _, property := range node.Properties {
		if property.Name == "editable" && (property.Value.Value == "plaintext" || property.Value.Value == "richtext") {
			return true
		}
	}
	return false
}
func accessibilitySnapshotMetadata(nodes []snapshotAXNode) map[string]snapshotAXMetadata {
	byID := map[string]snapshotAXNode{}
	editing := map[string]bool{}
	excluded := map[string]bool{}
	contaminated := map[string]bool{}
	for _, node := range nodes {
		byID[node.NodeID] = node
		if snapshotEditable(node) {
			editing[node.NodeID] = true
			contaminated[node.NodeID] = true
		}
	}
	for _, node := range nodes {
		visited := map[string]bool{}
		parent := node.ParentID
		for parent != "" && !visited[parent] {
			visited[parent] = true
			if editing[parent] {
				excluded[node.NodeID] = true
			}
			if editing[node.NodeID] {
				contaminated[parent] = true
			}
			parent = byID[parent].ParentID
		}
		if editing[node.NodeID] && (node.Role.Value == "StaticText" || node.Role.Value == "InlineTextBox") {
			excluded[node.NodeID] = true
		}
	}
	byDOM := map[int]snapshotAXNode{}
	children := map[string][]snapshotAXNode{}
	for _, node := range nodes {
		byDOM[node.BackendDOMNodeID] = node
		children[node.ParentID] = append(children[node.ParentID], node)
	}
	var safeText func(snapshotAXNode, map[string]bool) string
	safeText = func(node snapshotAXNode, visited map[string]bool) string {
		if editing[node.NodeID] || excluded[node.NodeID] || visited[node.NodeID] {
			return ""
		}
		visited[node.NodeID] = true
		if node.Role.Value == "StaticText" && !contaminated[node.NodeID] {
			return node.Name.Value
		}
		parts := []string{}
		for _, child := range children[node.NodeID] {
			if text := safeText(child, visited); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, " ")
	}
	privateDOM := map[int]bool{}
	for _, node := range nodes {
		if contaminated[node.NodeID] || excluded[node.NodeID] {
			privateDOM[node.BackendDOMNodeID] = true
		}
	}
	delete(privateDOM, 0)
	result := map[string]snapshotAXMetadata{}
	for _, node := range nodes {
		if excluded[node.NodeID] {
			result[node.NodeID] = snapshotAXMetadata{excluded: true}
			continue
		}
		var name *string
		if contaminated[node.NodeID] && len(node.Name.Sources) == 0 {
			text := safeText(node, map[string]bool{})
			name = &text
		}
		for _, source := range node.Name.Sources {
			if source.Superseded || source.Value == nil {
				continue
			}
			if source.Type == "contents" && contaminated[node.NodeID] {
				text := safeText(node, map[string]bool{})
				name = &text
			}
			for _, value := range []*snapshotAXValue{source.Value, source.AttributeValue, source.NativeSourceValue} {
				if value == nil {
					continue
				}
				unsafe := false
				for _, related := range value.RelatedNodes {
					if privateDOM[related.BackendDOMNodeID] {
						unsafe = true
					}
				}
				if unsafe {
					parts := []string{}
					for _, related := range value.RelatedNodes {
						if target, ok := byDOM[related.BackendDOMNodeID]; ok {
							if text := safeText(target, map[string]bool{}); text != "" {
								parts = append(parts, text)
							}
						}
					}
					text := strings.Join(parts, " ")
					name = &text
				}
			}
		}
		if name != nil {
			result[node.NodeID] = snapshotAXMetadata{name: name}
		}
	}
	return result
}
