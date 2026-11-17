/** `pr2video skill`: puts the agent skill where an agent that is not Claude Code looks for skills. */
import { access, cp } from "node:fs/promises"
import { join, resolve } from "node:path"

import { skillDir } from "./assets.ts"

export const SKILL_HELP = `Agent skill (for any coding agent that reads SKILL.md skills):
  pr2video skill install <skills folder> [--force]
                                                Copy the skill to <folder>/pr2video/, matching this CLI's
                                                version (e.g. .agents/skills, read by Codex,
                                                Cursor, Gemini CLI and others)
  pr2video skill path                           Where this install keeps the skill`

/** Copies the skill into `<folder>/pr2video/`; refuses to overwrite one already there unless `force`. */
export async function installSkill(
  folder: string,
  options: { force?: boolean | undefined } = {},
): Promise<string> {
  const target = join(resolve(folder), "pr2video")
  const exists = await access(target).then(
    () => true,
    () => false,
  )
  if (exists && !options.force)
    throw new Error(`${target} already exists; pass --force to replace it with this version`)
  await cp(await skillDir(), target, { recursive: true, force: true })
  return `installed the pr2video skill in ${target}`
}
