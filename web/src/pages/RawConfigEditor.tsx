// The raw configuration's text editor: CodeMirror 6 with YAML highlighting, line numbers, search (Mod-f), history,
// bracket matching and live YAML diagnostics; Tab is not captured, so it leaves the editor like any field. Secret
// placeholders are marked and atomic: the cursor steps over one and a deletion takes it whole.
//
// The editor lives in a shadow root. CodeMirror injects its styles through `style-mod`, which writes a `<style>`
// element into a document (refused by the panel's `style-src 'self'`, src/management/web-panel.ts) but a constructed
// stylesheet into a shadow root (`adoptedStyleSheets`, which no style-src governs). So the CSP stays as it is, and
// the theme below reaches the editor that way; the semantic colour tokens are custom properties, which inherit into
// the shadow tree, so the editor follows the light and dark themes with no colour of its own.
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { type Diagnostic, linter, lintKeymap } from "@codemirror/lint";
import { search, searchKeymap } from "@codemirror/search";
import {
  EditorSelection,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import { keptSecretPattern, type TextProblem, yamlProblems } from "../lib/raw-config.ts";
import styles from "./RawConfig.module.css";

export interface EditorHandle {
  /**
   * Put the cursor at `offset`, bring it to the middle of the editor and focus the editor; `land` also tints the line
   * for a moment (a deep link's landing), until the next edit or click.
   */
  readonly focusAt: (offset: number, options?: { readonly land?: boolean }) => void;
  /** Mark the problem the server found in the submitted text (`undefined` clears it). */
  readonly showProblem: (problem: TextProblem | undefined) => void;
  /** Replace the whole text as one edit, which undo brings back (same version only). */
  readonly replace: (text: string) => void;
  /**
   * Start over on a text with no undo history: after a reload or a save, undo must not bring back placeholders of
   * another configuration version.
   */
  readonly reset: (text: string) => void;
  readonly selectAll: () => void;
}

// ---------------------------------------------------------------------------------------------------------------
// Secret placeholders

const secretMark = Decoration.mark({
  class: "cm-secret",
  attributes: { title: "Secret, kept as stored" },
});

const secretMatcher = new MatchDecorator({ regexp: keptSecretPattern(), decoration: secretMark });

const secrets = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = secretMatcher.createDeco(view);
    }

    update(update: ViewUpdate) {
      this.decorations = secretMatcher.updateDeco(update, this.decorations);
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

// ---------------------------------------------------------------------------------------------------------------
// Wrapping: a long dotted key or URL breaks after a `.` or `/` (a `<wbr>` there), not after its indentation (which
// would leave an empty numbered row) and not in the middle of a word

class BreakWidget extends WidgetType {
  override toDOM() {
    return document.createElement("wbr");
  }

  override eq() {
    return true;
  }
}

const breakAfter = Decoration.widget({ widget: new BreakWidget(), side: 1 });

const breakMatcher = new MatchDecorator({
  regexp: /[./](?=[^\s./:])/g,
  decorate: (add, _from, to) => add(to, to, breakAfter),
});

const breaks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = breakMatcher.createDeco(view);
    }

    update(update: ViewUpdate) {
      this.decorations = breakMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// ---------------------------------------------------------------------------------------------------------------
// Landing: the line a deep link put the cursor on, tinted until the next edit, click or a few seconds pass

/** How long a deep link's landing line stays tinted. */
const LANDING_MS = 2500;

const setLanding = StateEffect.define<number | undefined>();

const landingLine = Decoration.line({ class: "cm-landing" });

const landing = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setLanding))
        return effect.value === undefined
          ? Decoration.none
          : Decoration.set(landingLine.range(transaction.state.doc.lineAt(effect.value).from));

    if (transaction.docChanged || transaction.isUserEvent("select.pointer")) return Decoration.none;

    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ---------------------------------------------------------------------------------------------------------------
// Diagnostics: YAML syntax while typing, plus the server's problem with the last submitted text

const setServerProblem = StateEffect.define<TextProblem | undefined>();

/** The server's problem, kept on its text while the operator edits around it, until the next check replaces it. */
const serverProblem = StateField.define<TextProblem | undefined>({
  create: () => undefined,
  update(problem, transaction) {
    for (const effect of transaction.effects) if (effect.is(setServerProblem)) return effect.value;

    if (problem === undefined || !transaction.docChanged) return problem;

    return {
      ...problem,
      from: transaction.changes.mapPos(problem.from, -1),
      to: transaction.changes.mapPos(problem.to, 1),
    };
  },
});

const yamlLinter = (onProblems: (problems: ReadonlyArray<TextProblem>) => void): Extension =>
  linter(
    (view): ReadonlyArray<Diagnostic> => {
      const problems = yamlProblems(view.state.doc.toString());
      const server = view.state.field(serverProblem);

      onProblems(problems);

      return [...problems, ...(server === undefined ? [] : [server])].map((problem) => ({
        from: Math.min(problem.from, view.state.doc.length),
        to: Math.min(problem.to, view.state.doc.length),
        severity: "error",
        message: problem.message,
      }));
    },
    {
      delay: 300,
      needsRefresh: (update) =>
        update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(setServerProblem)),
        ),
    },
  );

// ---------------------------------------------------------------------------------------------------------------
// Theme: DESIGN.md's semantic tokens only

const highlight = HighlightStyle.define([
  { tag: tags.definition(tags.propertyName), fontWeight: "700" },
  { tag: [tags.lineComment, tags.meta, tags.labelName, tags.typeName], color: "var(--quiet)" },
  {
    tag: [tags.separator, tags.punctuation, tags.squareBracket, tags.brace],
    color: "var(--quiet)",
  },
  { tag: tags.invalid, color: "var(--danger)" },
]);

/** A field's frame: the panel's text inputs. */
const fieldControl = {
  height: "2.25rem",
  margin: "0",
  padding: "0 var(--space-3)",
  backgroundColor: "var(--field)",
  backgroundImage: "none",
  color: "var(--text)",
  font: "inherit",
  fontSize: "var(--text-sm)",
  border: "2px solid var(--rule)",
  borderRadius: "var(--radius)",
};

/** A secondary button: outlined in the text colour. */
const buttonControl = {
  height: "2.25rem",
  margin: "0",
  padding: "0 var(--space-3)",
  backgroundColor: "var(--ground)",
  backgroundImage: "none",
  color: "var(--text)",
  font: "inherit",
  fontSize: "var(--text-sm)",
  fontWeight: "700",
  border: "2px solid var(--text)",
  borderRadius: "var(--radius)",
  cursor: "pointer",
};

const focusRing = { outline: "3px solid var(--focus)", outlineOffset: "2px" };

const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--field)",
    border: "2px solid var(--rule)",
    borderRadius: "var(--radius)",
    fontSize: "var(--text-sm)",
  },
  "&.cm-focused": { ...focusRing, borderColor: "var(--text)", outlineOffset: "0" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.6",
    fontVariantNumeric: "tabular-nums",
    scrollbarColor: "var(--rule) var(--field)",
  },
  ".cm-content": { padding: "var(--space-3) 0", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 var(--space-4) 0 var(--space-3)" },
  // A long key wraps at a `<wbr>` (`breaks`) where it can, anywhere only where it must.
  ".cm-content.cm-lineWrapping": { overflowWrap: "anywhere", wordBreak: "normal" },
  ".cm-landing": { backgroundColor: "var(--sunk)" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--text)" },
  ".cm-content ::selection, .cm-panels ::selection, .cm-tooltip ::selection": {
    backgroundColor: "var(--inverse)",
    color: "var(--on-inverse)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--sunk)",
    color: "var(--quiet)",
    border: "none",
    borderRight: "1px solid var(--hairline)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "2.75rem",
    padding: "0 var(--space-2) 0 var(--space-3)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--text)",
    fontWeight: "700",
  },
  ".cm-secret": {
    padding: "0.0625rem 0.1875rem",
    backgroundColor: "var(--sunk)",
    outline: "1px solid var(--rule)",
    borderRadius: "var(--radius)",
    fontWeight: "650",
    whiteSpace: "nowrap",
    cursor: "default",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--hairline)",
    outline: "1px solid var(--rule)",
    color: "inherit",
  },
  ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "transparent",
    color: "var(--danger)",
  },
  ".cm-searchMatch": { backgroundColor: "var(--hairline)", outline: "1px solid var(--rule)" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--inverse)",
    color: "var(--on-inverse)",
  },
  ".cm-searchMatch-selected *": { color: "inherit" },
  ".cm-panels": { backgroundColor: "var(--sunk)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--hairline)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--hairline)" },
  ".cm-panel.cm-search": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2) 2.75rem var(--space-2) var(--space-3)",
    fontSize: "var(--text-sm)",
  },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
    margin: "0",
  },
  ".cm-panel.cm-search br": { flexBasis: "100%", height: "0", content: '""' },
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    fontSize: "var(--text-xs)",
    fontWeight: "600",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    width: "1rem",
    height: "1rem",
    margin: "0",
    accentColor: "var(--text)",
  },
  ".cm-panel.cm-search [name=close]": {
    top: "var(--space-2)",
    right: "var(--space-2)",
    width: "2.25rem",
    height: "2.25rem",
    color: "var(--text)",
    fontSize: "var(--text-lg)",
    borderRadius: "var(--radius)",
    cursor: "pointer",
  },
  ".cm-panel.cm-search [name=close]:hover": { backgroundColor: "var(--hairline)" },
  ".cm-textfield": fieldControl,
  ".cm-textfield:focus-visible": { ...focusRing, borderColor: "var(--text)", outlineOffset: "0" },
  ".cm-button": buttonControl,
  ".cm-button:hover": { backgroundColor: "var(--sunk)" },
  ".cm-button:active": { backgroundColor: "var(--hairline)", backgroundImage: "none" },
  ".cm-button:focus-visible, .cm-panel.cm-search [name=close]:focus-visible, .cm-panel.cm-search input[type=checkbox]:focus-visible":
    focusRing,
  ".cm-tooltip": {
    color: "var(--text)",
    backgroundColor: "var(--raised)",
    border: "2px solid var(--text)",
    borderRadius: "var(--radius)",
  },
  ".cm-tooltip.cm-tooltip-lint": { padding: "0" },
  ".cm-diagnostic": {
    display: "flex",
    alignItems: "baseline",
    gap: "var(--space-2)",
    maxWidth: "32rem",
    padding: "var(--space-2) var(--space-3)",
    fontFamily: "inherit",
    fontSize: "var(--text-sm)",
    borderLeft: "none",
  },
  // The trail mark: the panel's sign for something failing.
  ".cm-diagnostic-error::before": {
    flex: "none",
    width: "1rem",
    height: "0.5rem",
    backgroundColor: "var(--danger)",
    content: '""',
  },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--danger)",
    textDecorationSkipInk: "none",
    textDecorationThickness: "1.5px",
    textUnderlineOffset: "0.25em",
  },
  ".cm-lintRange-active": { backgroundColor: "var(--sunk)" },
  ".cm-lintPoint-error:after": { borderBottomColor: "var(--danger)" },
});

// ---------------------------------------------------------------------------------------------------------------

interface Callbacks {
  readonly onChange: (text: string) => void;
  readonly onProblems: (problems: ReadonlyArray<TextProblem>) => void;
}

const extensions = (label: string, callbacks: { readonly current: Callbacks }): Extension => [
  lineNumbers(),
  highlightActiveLineGutter(),
  history(),
  indentOnInput(),
  bracketMatching(),
  search({ top: true }),
  EditorView.lineWrapping,
  EditorState.tabSize.of(2),
  indentUnit.of("  "),
  yaml(),
  syntaxHighlighting(highlight),
  secrets,
  breaks,
  serverProblem,
  yamlLinter((problems) => callbacks.current.onProblems(problems)),
  // No Tab binding (`indentWithTab`): Tab moves the focus on, as in any other field.
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...lintKeymap]),
  EditorView.contentAttributes.of({ "aria-label": label }),
  // The search panel in the panel's sentence case.
  EditorState.phrases.of({
    Find: "Find",
    Replace: "Replace",
    next: "Next",
    previous: "Previous",
    all: "All",
    "match case": "Match case",
    regexp: "Regular expression",
    "by word": "Whole word",
    replace: "Replace",
    "replace all": "Replace all",
    close: "Close",
  }),
  landing,
  EditorView.updateListener.of((update) => {
    if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
  }),
  theme,
];

export const RawConfigEditor = ({
  initial,
  label,
  onChange,
  onProblems,
  ref,
}: {
  readonly initial: string;
  /** The editor's accessible name. */
  readonly label: string;
  readonly onChange: (text: string) => void;
  readonly onProblems: (problems: ReadonlyArray<TextProblem>) => void;
  readonly ref?: Ref<EditorHandle>;
}) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const callbacks = useRef<Callbacks>({ onChange, onProblems });
  const firstText = useRef(initial);
  const landed = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    callbacks.current = { onChange, onProblems };
  });

  useEffect(() => {
    const element = host.current;

    if (element === null) return;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    const parent = document.createElement("div");

    parent.style.height = "100%";
    shadow.replaceChildren(parent);

    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: firstText.current,
        extensions: extensions(label, callbacks),
      }),
    });

    view.current = editor;

    return () => {
      clearTimeout(landed.current);
      editor.destroy();
      view.current = undefined;
      shadow.replaceChildren();
    };
  }, [label]);

  useImperativeHandle(
    ref,
    () => ({
      focusAt: (offset, options) => {
        const editor = view.current;

        if (editor === undefined) return;
        const position = Math.min(Math.max(0, offset), editor.state.doc.length);

        host.current?.scrollIntoView({ block: "nearest" });
        editor.dispatch({
          selection: EditorSelection.cursor(position),
          effects: [
            EditorView.scrollIntoView(position, { y: "center" }),
            setLanding.of(options?.land === true ? position : undefined),
          ],
        });
        editor.focus();

        clearTimeout(landed.current);

        if (options?.land === true)
          landed.current = setTimeout(() => {
            if (view.current === editor) editor.dispatch({ effects: setLanding.of(undefined) });
          }, LANDING_MS);
      },
      showProblem: (problem) => view.current?.dispatch({ effects: setServerProblem.of(problem) }),
      replace: (text) => {
        const editor = view.current;

        editor?.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: text },
          effects: setServerProblem.of(undefined),
        });
      },
      reset: (text) => {
        firstText.current = text;
        view.current?.setState(
          EditorState.create({ doc: text, extensions: extensions(label, callbacks) }),
        );
      },
      selectAll: () => {
        const editor = view.current;

        if (editor === undefined) return;
        editor.dispatch({ selection: EditorSelection.range(0, editor.state.doc.length) });
        editor.focus();
      },
    }),
    [label],
  );

  return <div ref={host} className={styles["editor"]} />;
};
