import type { FilePart } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { pathToFileURL } from "bun"
import path from "node:path"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { selectedForeground } from "../../context/theme"
import { usePromptRef } from "../../context/prompt"
import { useBindings } from "../../keymap"

const id = "internal:sidebar-explorer"
const MAX_ENTRIES = 500

type Entry = {
  path: string
  name: string
  directory: boolean
}

type Row = Entry & {
  depth: number
}

function normalize(value: string) {
  return value.replaceAll("\\", "/").replace(/\/$/, "") || "/"
}

function childEntries(entries: Entry[], directory: string, root: string) {
  return entries
    .filter((entry) => {
      const relative = path.relative(directory, entry.path)
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep)
    })
    .map((entry) => ({ ...entry, name: path.basename(entry.path) }))
    .sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1))
}

function flatten(entries: Entry[], root: string, expanded: ReadonlySet<string>): Row[] {
  const result: Row[] = []
  const visit = (directory: string, depth: number) => {
    for (const entry of childEntries(entries, directory, root)) {
      result.push({ ...entry, depth })
      if (entry.directory && expanded.has(entry.path)) visit(entry.path, depth + 1)
    }
  }
  visit(root, 0)
  return result
}

function FileExplorer(props: { api: TuiPluginApi; session_id: string }) {
  const prompt = usePromptRef()
  const theme = () => props.api.theme.current
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const root = createMemo(() => normalize(session()?.directory || props.api.state.path.directory))
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = createSignal(0)
  const [refresh, setRefresh] = createSignal(0)

  const [entries] = createResource(
    () => {
      const directory = root()
      refresh()
      return directory
    },
    async (directory) => {
      if (!directory) return []
      try {
        const [directories, files] = await Promise.all([
          props.api.client.find.files({ query: { query: "*", type: "directory", directory, limit: MAX_ENTRIES } }),
          props.api.client.find.files({ query: { query: "*", type: "file", directory, limit: MAX_ENTRIES } }),
        ])
        return [
          ...(directories.data ?? []).map((value) => ({ path: normalize(value), name: path.basename(value), directory: true })),
          ...(files.data ?? []).map((value) => ({ path: normalize(value), name: path.basename(value), directory: false })),
        ] satisfies Entry[]
      } catch {
        return []
      }
    },
  )

  const rows = createMemo(() => flatten(entries() ?? [], root(), expanded()))
  const current = createMemo(() => rows()[Math.min(selected(), Math.max(0, rows().length - 1))])

  const move = (offset: number) => {
    if (!rows().length) return
    setSelected((value) => Math.max(0, Math.min(rows().length - 1, value + offset)))
  }

  const toggle = (entry: Entry | undefined) => {
    if (!entry?.directory) return
    setExpanded((value) => {
      const next = new Set(value)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
  }

  const tag = () => {
    const entry = current()
    if (!entry || entry.directory || !prompt.current) return

    const value = `@${path.relative(root(), entry.path).split(path.sep).join("/")}`
    const input = prompt.current.current.input
    const separator = input && !input.endsWith(" ") ? " " : ""
    const start = input.length + separator.length
    const text = `${separator}${value} `
    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file",
      mime: "text/plain",
      filename: value.slice(1),
      url: pathToFileURL(entry.path).href,
      source: {
        type: "file",
        path: entry.path,
        text: {
          start,
          end: start + value.length,
          value,
        },
      },
    }

    prompt.current.set({
      ...prompt.current.current,
      input: input + text,
      parts: [...prompt.current.current.parts, part],
    })
    prompt.current.focus()
    props.api.ui.toast({ message: `Tagged ${value}`, variant: "info" })
  }

  useBindings(() => ({
    commands: [
      { name: "sidebar.explorer.down", title: "Move down in file explorer", category: "File Explorer", hidden: true, run: () => move(1) },
      { name: "sidebar.explorer.up", title: "Move up in file explorer", category: "File Explorer", hidden: true, run: () => move(-1) },
      { name: "sidebar.explorer.toggle", title: "Expand or collapse file explorer item", category: "File Explorer", hidden: true, run: () => toggle(current()) },
      { name: "sidebar.explorer.tag", title: "Tag selected file in prompt", category: "File Explorer", hidden: true, run: tag },
      { name: "sidebar.explorer.refresh", title: "Refresh file explorer", category: "File Explorer", hidden: true, run: () => setRefresh((value) => value + 1) },
    ],
    bindings: [
      { key: "down", cmd: "sidebar.explorer.down", desc: "Next file" },
      { key: "up", cmd: "sidebar.explorer.up", desc: "Previous file" },
      { key: "enter", cmd: "sidebar.explorer.toggle", desc: "Expand/collapse" },
      { key: "shift+enter", cmd: "sidebar.explorer.tag", desc: "Tag file in prompt" },
      { key: "r", cmd: "sidebar.explorer.refresh", desc: "Refresh" },
    ],
  }))

  return (
    <box gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}><b>Files</b></text>
        <text fg={theme().textMuted}>j/k navigate · ⇧↵ tag</text>
      </box>
      <Show when={!entries.loading} fallback={<text fg={theme().textMuted}>Loading files…</text>}>
        <Show when={rows().length > 0} fallback={<text fg={theme().textMuted}>No files found</text>}>
          <For each={rows()}>
            {(entry, index) => {
              const active = () => index() === selected()
              const open = () => expanded().has(entry.path)
              return (
                <box
                  paddingLeft={entry.depth * 2}
                  backgroundColor={active() ? theme().primary : undefined}
                  onMouseDown={() => setSelected(index())}
                  onMouseUp={() => (entry.directory ? toggle(entry) : tag())}
                >
                  <text fg={active() ? selectedForeground(theme()) : entry.directory ? theme().text : theme().textMuted}>
                    {entry.directory ? (open() ? "▾ " : "▸ ") : "  "}{entry.name}
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 50,
    slots: {
      sidebar_content(_ctx, props) {
        return <FileExplorer api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
