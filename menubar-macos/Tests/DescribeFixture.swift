import Foundation
import XCTest

/// The exact bytes `nessie-executor describe --state-dir …` printed for the
/// paired development executor on 2026-09-16. Decoding this — rather than a
/// hand-written literal — is what proves the app renders the CLI's own answer.
///
/// Two details in it are load-bearing. A real wildcard entry proves the sections
/// render a permitted *command* rather than assuming a bare program name; and
/// `policy.workspaceFolders` is empty while `reach.folders` names one, which is
/// what a descriptor signed before folders had names looks like.
let describeFixtureJSON = """
{
  "apiBaseUrl": "http://127.0.0.1:5454",
  "executorId": "32b7de69-e303-46d6-b864-8a99a80d25e6",
  "policy": {
    "limits": {
      "maxCommandRuntimeSeconds": 30,
      "maxResultBytes": 65536,
      "maxSessions": 1
    },
    "operations": [
      "file.list",
      "file.read",
      "file.write",
      "workspace.review",
      "sandbox.stop"
    ],
    "permittedPrograms": [
      "git *",
      "node",
      "npm run *"
    ],
    "profiles": [
      "workspace_sandbox"
    ],
    "revision": 5,
    "workspaceFolders": []
  },
  "reach": {
    "allowedOrigins": [],
    "folders": [
      {
        "name": "workspace",
        "path": "/Users/dictator/.nessie-executor-dev/workspace"
      }
    ],
    "guestSessions": "available"
  },
  "sandbox": {
    "browserConfigured": false,
    "codingConfigured": false,
    "promotionHelperConfigured": false
  }
}
"""

func sampleDescription(
    file: StaticString = #filePath,
    line: UInt = #line
) -> ExecutorDescription {
    // swiftlint:disable:next force_try
    try! ExecutorDescription.decode(Data(describeFixtureJSON.utf8))
}
