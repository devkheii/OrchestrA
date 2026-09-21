import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import { SESSION_COMMANDS } from "../session-commands.js";
import type { Line, Prompt, SessionState, SelectOption } from "./state.js";

/**
 * The session, rendered.
 *
 * Every decision here is about a terminal that is being watched while it
 * works. Nothing in this file talks to a model, resolves a provider or writes
 * a config; it renders state and reports keystrokes. What it renders is
 * produced by the same `runTurn`, `sessionApprover` and `runSessionCommand`
 * the line-based session used, which is why replacing the view did not need
 * the logic to be rewritten or re-tested.
 */

export interface AppProps {
  initial: SessionState;
  /** Subscribes to state changes produced by the session driver. */
  subscribe: (listener: (state: SessionState) => void) => () => void;
  /** A line the user typed at the main prompt. */
  onSubmit: (text: string) => void;
  /** An answer to whatever the session is currently asking. */
  onAnswer: (answer: string) => void;
  /** Escape or ctrl-c while something is running. */
  onCancel: () => void;
}

export function App({ initial, subscribe, onSubmit, onAnswer, onCancel }: AppProps) {
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState("");
  const { exit } = useApp();

  useEffect(() => subscribe(setState), [subscribe]);
  useEffect(() => {
    if (state.done) exit();
  }, [state.done, exit]);

  // Escape cancels what is running rather than leaving. Leaving is /exit,
  // which is deliberate: a key that quits is a key pressed by accident.
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Header state={state} />
      <Transcript lines={state.lines} />
      <Prompter
        prompt={state.prompt}
        draft={draft}
        setDraft={setDraft}
        onSubmit={(text) => {
          setDraft("");
          onSubmit(text);
        }}
        onAnswer={onAnswer}
      />
    </Box>
  );
}

/** The longest usage string, plus a space, so no row runs into its summary. */
const COMMAND_COLUMN =
  Math.max(...SESSION_COMMANDS.map((c) => (c.usage ?? c.name).length)) + 2;

function Header({ state }: { state: SessionState }) {
  const { workspace, label, local, mode } = state.header;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold>dem</Text>
        <Text dimColor>  {workspace}</Text>
      </Box>
      <Box>
        {/*
          Whether context leaves this machine is the first thing a user needs
          and the easiest thing to forget configuring, so it is in the frame
          rather than in a message that scrolls away.
        */}
        <Text color={local ? "green" : "yellow"} bold={!local}>
          {local ? "LOCAL " : "REMOTE"}
        </Text>
        <Text dimColor>  {label}  ·  mode {mode}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {SESSION_COMMANDS.map((command) => (
          <Text key={command.name} dimColor>
            {"  "}
            {/* Wide enough for the longest usage string plus a gap. A
                column that some rows overflow is worse than no column. */}
            {(command.usage ?? command.name).padEnd(COMMAND_COLUMN)}
            {command.summary}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function Transcript({ lines }: { lines: readonly Line[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((entry) => (
        <Box key={entry.id} marginBottom={entry.role === "assistant" ? 1 : 0}>
          <Text {...colorFor(entry.role)} dimColor={entry.role === "system"}>
            {prefixFor(entry.role)}
          </Text>
          <Text dimColor={entry.role === "system" || entry.role === "tool"}>{entry.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

function prefixFor(role: Line["role"]): string {
  switch (role) {
    case "user": return "> ";
    case "assistant": return "";
    case "tool": return "  ● ";
    default: return "  ";
  }
}

/**
 * Spread rather than returned, because `exactOptionalPropertyTypes` treats a
 * prop explicitly set to undefined as different from one that is absent — and
 * "no colour" here means absent.
 */
function colorFor(role: Line["role"]): { color?: string } {
  if (role === "user") return { color: "cyan" };
  if (role === "tool") return { color: "yellow" };
  return {};
}

interface PrompterProps {
  prompt: Prompt;
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: (text: string) => void;
  onAnswer: (answer: string) => void;
}

function Prompter({ prompt, draft, setDraft, onSubmit, onAnswer }: PrompterProps) {
  switch (prompt.kind) {
    case "busy":
      return (
        <Box>
          <Text dimColor>{prompt.note}  </Text>
          <Text dimColor>esc to cancel</Text>
        </Box>
      );

    case "approval":
      return <Approval pending={prompt.pending} onAnswer={onAnswer} />;

    case "select":
      return (
        <Box flexDirection="column">
          <Text bold>{prompt.request.title}</Text>
          <SelectInput
            items={prompt.request.options.map(toItem)}
            onSelect={(item) => onAnswer(String(item.value))}
          />
        </Box>
      );

    case "ask":
      return (
        <Box>
          <Text>{prompt.request.question}</Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={(value) => {
              setDraft("");
              onAnswer(value);
            }}
            // A credential typed in front of someone is a credential to
            // rotate, so it is masked here for the same reason `dem auth`
            // suppresses echo.
            {...(prompt.request.secret ? { mask: "•" } : {})}
          />
        </Box>
      );

    default:
      return (
        <Box>
          <Text bold color="cyan">{"> "}</Text>
          <TextInput value={draft} onChange={setDraft} onSubmit={onSubmit} />
        </Box>
      );
  }
}

function toItem(option: SelectOption) {
  const detail = option.detail ? `  ${option.detail}` : "";
  return {
    key: option.value,
    label: `${option.current ? "• " : "  "}${option.label}${detail}`,
    value: option.value,
  };
}

/**
 * The approval prompt.
 *
 * Arrow keys rather than a typed letter, because the default has to be "no"
 * and a default that requires typing the right character is one people defeat
 * by holding return. The first item is the safe one.
 */
function Approval({
  pending,
  onAnswer,
}: {
  pending: { tool: string; subject: string; rule: string };
  onAnswer: (answer: string) => void;
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="yellow">{pending.tool}</Text>
        <Text>  {pending.subject}</Text>
      </Box>
      <Text dimColor>{pending.rule}</Text>
      <SelectInput
        items={[
          { key: "no", label: "No", value: "n" },
          { key: "yes", label: "Yes, once", value: "y" },
          { key: "always", label: "Yes, and stop asking for this exact command", value: "a" },
        ]}
        onSelect={(item) => onAnswer(String(item.value))}
      />
    </Box>
  );
}
