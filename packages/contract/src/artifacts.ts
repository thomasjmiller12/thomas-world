import { z } from "zod";

// The artifact economy (plan §6): the kinds of persistent content agents make.
//  - blog_post     Writer (anyone via cafe) — cafe press / library bookshelf
//  - project_log   Builder — workshop monitor
//  - research_note Researcher — library desk
//  - bulletin      anyone — town square notice board
//  - fun_list      Hobby — park
//  - diary_entry   all (nightly reflection) — feed flavor
//  - daily_digest  the Town Crier (world nightly job)
//  - interactive   a self-contained single-file web app (HTML/CSS/JS) an agent
//                  BUILT — rendered in a sandboxed iframe, mountable on world
//                  objects, with a per-artifact keyed state store visitors and
//                  the owning agent both read/write (programmable-world D1/D3)
//  - shared_page   a page/article an agent pulled in to share on a room screen
//                  (read_web_page → share_to_screen); markdown-ish text body
export const artifactKinds = [
  "blog_post",
  "project_log",
  "research_note",
  "bulletin",
  "fun_list",
  "diary_entry",
  "daily_digest",
  "interactive",
  "shared_page",
] as const;
export const ArtifactKind = z.enum(artifactKinds);
export type ArtifactKind = z.infer<typeof ArtifactKind>;
