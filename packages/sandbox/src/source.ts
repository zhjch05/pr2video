/**
 * Getting the project into a sandbox without mounting the host's folder: the
 * sandbox runs the project's code as root, and a mount (even a read-only
 * one, which root can remount) would hand it the whole folder, `.env` files
 * and all, for as long as it runs. Instead the host packs only what the
 * sandbox needs and streams it in as a tar: for commits, a bare repository
 * holding just those commits; for a folder, the files git would keep.
 */
import { execFile, spawn } from "node:child_process"
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * Streams `files` (paths relative to `dir`, or all of `dir` when omitted)
 * into `dest` inside the container.
 */
export function tarInto(
  container: string,
  dir: string,
  dest: string,
  files?: ReadonlyArray<string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // macOS's tar adds `._` files and extended attributes unless told not to.
    const mac = process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : []
    const tar = spawn(
      "tar",
      ["-C", dir, ...mac, "-cf", "-", ...(files ? ["--null", "-T", "-"] : ["."])],
      {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    const into = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "sh",
        "-c",
        `mkdir -p '${dest}' && tar -C '${dest}' --warning=no-unknown-keyword -xf -`,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    )
    let errors = ""
    tar.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8")
    })
    into.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8")
    })
    into.stdin.on("error", () => {})
    tar.stdout.pipe(into.stdin)
    tar.stdin.on("error", () => {})
    tar.stdin.end(files ? files.map((file) => `${file}\0`).join("") : "")
    const done = (which: string) =>
      new Promise<number | null>((settle, fail) => {
        const child = which === "tar" ? tar : into
        child.on("error", fail)
        child.on("close", settle)
      })
    Promise.all([done("tar"), done("docker")]).then(([packed, unpacked]) => {
      if (packed === 0 && unpacked === 0) resolve()
      else
        reject(
          new Error(`could not copy the project into the sandbox: ${errors.trim().slice(-2_000)}`),
        )
    }, reject)
  })
}

/** Whether any part of `path` is one of `names`. */
function excluded(path: string, names: ReadonlyArray<string>): boolean {
  return path.split("/").some((part) => names.includes(part))
}

/**
 * The folder's files as `sandbox up --folder` copies them: in git, what git
 * would keep (tracked and untracked, not ignored, not deleted); otherwise
 * everything. Either way not `excludes` (`.git`, `node_modules`, ...).
 */
export async function folderFiles(
  dir: string,
  isGit: boolean,
  excludes: ReadonlyArray<string>,
): Promise<Array<string>> {
  if (isGit) {
    const { stdout } = await run(
      "git",
      ["-C", dir, "ls-files", "-z", "-co", "--exclude-standard"],
      { maxBuffer: 256 * 1024 * 1024 },
    )
    const listed = [...new Set(stdout.split("\0").filter(Boolean))]
    const kept: Array<string> = []
    for (const file of listed) {
      if (excluded(file, excludes)) continue
      // A tracked file deleted from the folder is still listed.
      if (
        await lstat(join(dir, file)).then(
          () => true,
          () => false,
        )
      )
        kept.push(file)
    }
    return kept
  }
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .filter((file) => file && !excluded(file, excludes))
}

/**
 * A bare repository in a temporary folder holding just `commits` (no
 * history), to stream into the sandbox; the caller removes it.
 */
export async function commitsRepo(repo: string, commits: ReadonlyArray<string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pr2video-src-"))
  try {
    await run("git", ["init", "-q", "--bare", dir])
    await run(
      "git",
      [
        "-C",
        dir,
        "fetch",
        "-q",
        "--no-tags",
        "--depth",
        "1",
        "--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack",
        repo,
        ...commits,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    )
    for (const [i, sha] of commits.entries())
      await run("git", ["-C", dir, "update-ref", `refs/pr2video/${i}`, sha])
    return dir
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}
