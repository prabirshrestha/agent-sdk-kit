// claude provider — deleteSession path encoding.
//
// Bug: previous implementation replaced only `/` with `-` when computing
// `~/.claude/projects/<encoded-cwd>/`. Claude actually replaces BOTH `/`
// AND `.` with `-` (verified by sampling real project dirs and confirmed
// by the agent-runner reference impl). Any cwd containing a dot — which
// includes every dotfile dir like `~/.config/foo` and any path with a
// version suffix like `project.v2` — would compute the wrong path and the
// unlink would silently no-op, leaking the session file on disk.
//
// We test the exported helpers directly rather than going through
// `provider.deleteSession()` because `os.homedir()` is not overridable
// via `process.env.HOME` on macOS (libuv reads the password database),
// and we don't want tests touching the real `~/.claude` directory.
import { describe, test, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { encodeClaudeProjectDir, claudeSessionFilePath } from "../../src/providers/claude.js";

describe("encodeClaudeProjectDir", () => {
  test("replaces `/` with `-`", () => {
    expect(encodeClaudeProjectDir("/Users/me/repo")).toBe("-Users-me-repo");
  });

  test("replaces `.` with `-` (the bug this fixes)", () => {
    expect(encodeClaudeProjectDir("/Users/me/project.v2")).toBe("-Users-me-project-v2");
  });

  test("dotfile directories collapse to double-dash", () => {
    expect(encodeClaudeProjectDir("/home/me/.config/agent")).toBe("-home-me--config-agent");
  });

  test("multiple dots in a single segment all replaced", () => {
    expect(encodeClaudeProjectDir("/a/b.c.d.e")).toBe("-a-b-c-d-e");
  });

  test("no slashes or dots → returned unchanged", () => {
    expect(encodeClaudeProjectDir("plain")).toBe("plain");
  });
});

describe("claudeSessionFilePath", () => {
  const sid = "00000000-0000-0000-0000-000000000001";

  test("composes into ~/.claude/projects/<encoded>/<sid>.jsonl", () => {
    const cwd = "/Users/me/project.v2";
    const expected = path.join(
      os.homedir(),
      ".claude",
      "projects",
      "-Users-me-project-v2",
      `${sid}.jsonl`,
    );
    expect(claudeSessionFilePath(cwd, sid)).toBe(expected);
  });

  test("dotted cwd does NOT regress to slash-only encoding", () => {
    const got = claudeSessionFilePath("/Users/me/project.v2", sid);
    expect(got).not.toContain("project.v2");
    expect(got).toContain("project-v2");
  });
});
