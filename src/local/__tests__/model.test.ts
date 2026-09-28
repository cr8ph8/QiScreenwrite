import { describe, expect, it } from "vitest";
import { buildDraftData, canonicalJson, fieldsFromData, hashCanonical, linkId, linksFor, newDraftId, recoveryIsUseful, sortDrafts, type RecoveryCopy } from "../model";
import type { DraftRecord, LinkRecord } from "../types";

const project = "local-writer:test";

describe("local writer model", () => {
  it("builds a draft in the QiMovi-compatible v2 shape and omits empty optionals", () => {
    const data = buildDraftData(project, { title: "  ", body: "FADE IN:", genre: "", projectFormat: "", targetPages: "", logline: "  " });
    expect(data).toEqual({ schemaVersion: 2, projectId: project, sourceHash: null, title: "Untitled screenplay", format: "FOUNTAIN", body: "FADE IN:", status: "DRAFT" });
    const full = buildDraftData(project, { title: "Drifter", body: "", genre: "Sci-fi", projectFormat: "feature", targetPages: 95, logline: "A drifter." });
    expect(full).toMatchObject({ genre: "Sci-fi", projectFormat: "feature", targetPages: 95, logline: "A drifter." });
    expect(fieldsFromData(full)).toEqual({ title: "Drifter", body: "", genre: "Sci-fi", projectFormat: "feature", targetPages: 95, logline: "A drifter." });
    expect(buildDraftData(project, { title: "x", body: "", targetPages: 0 }).targetPages).toBeUndefined();
  });

  it("canonical JSON matches the service byte for byte", async () => {
    expect(canonicalJson({ b: [1, { z: "x", a: null }], a: true, u: undefined })).toBe('{"a":true,"b":[1,{"a":null,"z":"x"}]}');
    expect(() => canonicalJson({ n: 1.5 })).toThrow(/non-canonical/);
    // sha256 of '{"a":1}', the same digest local/server/storage.mjs produces.
    expect(await hashCanonical({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
  });

  it("derives identities and finds links per draft", () => {
    const id = newDraftId();
    expect(id).toMatch(/^screenplay-draft:[0-9a-f-]{36}$/);
    expect(linkId("qimovi", id)).toBe(`sync-link:qimovi:${id.slice("screenplay-draft:".length)}`);
    const link = { id: linkId("competition", id), kind: "sync-link", version: 1, sha256: "a".repeat(64), data: { draftId: id, target: "competition" } } as unknown as LinkRecord;
    const other = { ...link, id: "sync-link:qimovi:other", data: { draftId: "screenplay-draft:other", target: "qimovi" } } as unknown as LinkRecord;
    expect(linksFor([link, other], id)).toEqual([link]);
  });

  it("keeps a recovery copy only when it differs from the saved revision", () => {
    const data = buildDraftData(project, { title: "T", body: "INT. A - DAY" });
    const saved = { id: "screenplay-draft:x", kind: "screenplay-draft", version: 2, sha256: "b".repeat(64), data } as DraftRecord;
    const copy: RecoveryCopy = { schema: "caniscreenwrite-local-writer-recovery/v1", draftId: saved.id, baseVersion: 2, baseSha256: saved.sha256, data, savedAt: "2026-09-16T00:00:00Z" };
    expect(recoveryIsUseful(copy, saved)).toBe(false);
    expect(recoveryIsUseful({ ...copy, data: { ...data, body: "INT. A - NIGHT" } }, saved)).toBe(true);
    expect(recoveryIsUseful({ ...copy, data: { ...data, body: "   " } }, null)).toBe(false);
    expect(recoveryIsUseful(null, saved)).toBe(false);
  });

  it("sorts drafts by most recent revision", () => {
    const make = (id: string, version: number, title: string) => ({ id, kind: "screenplay-draft", version, sha256: "c".repeat(64), data: buildDraftData(project, { title, body: "" }) }) as DraftRecord;
    expect(sortDrafts([make("screenplay-draft:a", 1, "Zed"), make("screenplay-draft:b", 3, "Beta"), make("screenplay-draft:c", 1, "Alpha")]).map((d) => d.data.title)).toEqual(["Beta", "Alpha", "Zed"]);
  });
});
