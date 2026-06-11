import { z } from "zod";

// The artifact economy (plan §6): the kinds of persistent content agents make.
//  - blog_post     Writer (anyone via cafe) — cafe press / library bookshelf
//  - project_log   Builder — workshop monitor
//  - research_note Researcher — library desk
//  - bulletin      anyone — town square notice board
//  - fun_list      Hobby — park
//  - diary_entry   all (nightly reflection) — feed flavor
//  - daily_digest  the Town Crier (world nightly job)
export const artifactKinds = [
  "blog_post",
  "project_log",
  "research_note",
  "bulletin",
  "fun_list",
  "diary_entry",
  "daily_digest",
] as const;
export const ArtifactKind = z.enum(artifactKinds);
export type ArtifactKind = z.infer<typeof ArtifactKind>;
