import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import path from "node:path"

const id = "internal:sidebar-explorer"
const MAX_ENTRIES = 200

type Entry = {
  path: string
  name: string
  directory: boolean
}

function relativeName(value: string, root: string) {
  const relative = path.relative(root, value)
  return relative || path.basename(value) || value
}

function normalize(value: string) {
  return value.replaceAll("\\", "/").replace(/\/$/, "") || "/"
}

function Explorer(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const root = createMemo(() => session()?.directory || props.api.state.path.directory)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
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
          props.api.client.find.files({
            query: { query: "*", type: "directory", directory, limit: MAX_ENTRIES },
          }),
          props.api.client.find.files({
            query: { query: "*", type: "file", directory, limit: MAX_ENTRIES },
          }),
        ])
        const values: Entry[] = [
          ...(directories.data ?? []).map((item) => ({
            path: normalize(item),
            name: relativeName(item, directory),
            directory: true,
          })),
          ...(files.data ?? []).map((item) => ({
            path: normalize(item),
            name: relativeName(item, directory),
            directory: false,
          })),
        ]
        return values.toSorted((a, b) => {
          if (a.directory !== b.directory) return a.directory ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      } catch {
        return []
      }
    },
  )

  const isExpanded = (directory: string) => expanded().has(directory)
  const toggle = (directory: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(directory)) next.delete(directory)
      else next.add(directory)
      return next
    })
  }

  const addFileToPrompt = (file: string) => {
    void props.api.client.tui.appendPrompt({ text: `@${file}` })
    props.api.ui.toast({ message: `Added ${file} to the prompt`, variant: "info" })
  }

  const renderDirectory = (directory: string, depth: number): ReturnType<typeof Directory> => {
    const prefix = "  ".repeat(depth)
    return (
      <Directory
        api={props.api}
        directory={directory}
        depth={depth}
        prefix={prefix}
        expanded={isExpanded(directory)}
        onToggle={() => toggle(directory)}
        onRefresh={() => setRefresh((value) => value + 1)}
        onFile={addFileToPrompt}
      />
    )
  }

  return (
    <box gap={1}>
      <box flexDirection="row" gap={1} onMouseDown={() => setRefresh((value) => value + 1)}>
        <text fg={theme().text}><b>Files</b></text>
        <text fg={theme().textMuted}>↻</text>
      </box>
      <Show when={!entries.loading} fallback={<text fg={theme().textMuted}>Loading files…</text>}>
        <Show when={entries()?.length} fallback={<text fg={theme().textMuted}>No files found</text>}>
          <For each={entries()}>
            {(entry) => (
              <Show
                when={entry.directory}
                fallback={
                  <text fg={theme().textMuted} onMouseUp={() => addFileToPrompt(entry.path)}>
                    {"  "}{entry.name}
                  </text>
                }
              >
                <box>
                  <text fg={theme().text} onMouseUp={() => toggle(entry.path)}>
                    {isExpanded(entry.path) ? "▾ " : "▸ "}{entry.name}
                  </text>
                  <Show when={isExpanded(entry.path)}>{renderDirectory(entry.path, 1)}</Show>
                </box>
              </Show>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

function Directory(props: {
  api: TuiPluginApi
  directory: string
  depth: number
  prefix: string
  expanded: boolean
  onToggle: () => void
  onRefresh: () => void
  onFile: (file: string) => void
}) {
  const theme = () => props.api.theme.current
  const [entries] = createResource(
    () => (props.expanded ? props.directory : undefined),
    async (directory) => {
      if (!directory) return []
      try {
        const [directories, files] = await Promise.all([
          props.api.client.find.files({ query: { query: "*", type: "directory", directory, limit: MAX_ENTRIES } }),
          props.api.client.find.files({ query: { query: "*", type: "file", directory, limit: MAX_ENTRIES } }),
        ])
        return [
          ...(directories.data ?? []).map((item) => ({ path: normalize(item), name: path.basename(item), directory: true })),
          ...(files.data ?? []).map((item) => ({ path: normalize(item), name: path.basename(item), directory: false })),
        ].toSorted((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1))
      } catch {
        return []
      }
    },
  )
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set())

  return (
    <Show when={props.expanded}>
      <Show when={!entries.loading} fallback={<text fg={theme().textMuted}>{props.prefix}Loading…</text>}>
        <For each={entries()}>
          {(entry) => (
            <Show
              when={entry.directory}
              fallback={<text fg={theme().textMuted} onMouseUp={() => props.onFile(entry.path)}>{props.prefix}  {entry.name}</text>}
            >
              <text fg={theme().text} onMouseUp={() => setOpen((current) => {
                const next = new Set(current)
                if (next.has(entry.path)) next.delete(entry.path)
                else next.add(entry.path)
                return next
              })}>
                {props.prefix}{open().has(entry.path) ? "▾ " : "▸ "}{entry.name}
              </text>
              <Show when={open().has(entry.path)}>
                <Directory {...props} directory={entry.path} depth={props.depth + 1} prefix={`${props.prefix}  `} expanded={true} />
              </Show>
            </Show>
          )}
        </For>
      </Show>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 50,
    slots: {
      sidebar_content(_ctx, props) {
        return <Explorer api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
