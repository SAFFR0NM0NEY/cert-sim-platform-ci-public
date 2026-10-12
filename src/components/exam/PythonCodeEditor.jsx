import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { tags } from '@lezer/highlight';

const pythonHighlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: '#c586c0' },
  { tag: [tags.name, tags.variableName], color: '#9cdcfe' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: '#dcdcaa' },
  { tag: [tags.string, tags.special(tags.string)], color: '#ce9178' },
  { tag: [tags.number, tags.bool, tags.null], color: '#b5cea8' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#6a9955', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className], color: '#4ec9b0' },
  { tag: [tags.operator, tags.punctuation], color: '#d4d4d4' },
]);

const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: '#1e1e1e',
    color: '#d4d4d4',
    fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace',
    fontSize: '0.95rem',
    height: '100%',
  },
  '&.cm-focused': { outline: '2px solid #60a5fa', outlineOffset: '-2px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: '1.55' },
  '.cm-content': { caretColor: '#ffffff', minHeight: '22rem', padding: '0.75rem 0' },
  '.cm-line': { padding: '0 1rem' },
  '.cm-gutters': {
    backgroundColor: '#1e1e1e',
    borderRight: '1px solid #333333',
    color: '#858585',
  },
  '.cm-activeLine': { backgroundColor: '#2a2d2e' },
  '.cm-activeLineGutter': { backgroundColor: '#2a2d2e', color: '#c6c6c6' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#264f78' },
  '.cm-matchingBracket': { backgroundColor: '#3a3d41', outline: '1px solid #888888' },
}, { dark: true });

export default function PythonCodeEditor({
  describedBy,
  disabled = false,
  id,
  label,
  onChange,
  value,
}) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const applyingExternal = useRef(false);
  const editable = useRef(new Compartment());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        EditorState.tabSize.of(4),
        indentUnit.of('    '),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        python(),
        syntaxHighlighting(pythonHighlighting),
        editorTheme,
        editable.current.of(EditorView.editable.of(!disabled)),
        EditorView.contentAttributes.of({
          id,
          'aria-label': label,
          'aria-describedby': describedBy,
          'aria-disabled': String(disabled),
          autocapitalize: 'off',
          autocomplete: 'off',
          autocorrect: 'off',
          spellcheck: 'false',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingExternal.current) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [describedBy, id, label]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!disabled)) });
    view.contentDOM.setAttribute('aria-disabled', String(disabled));
  }, [disabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    applyingExternal.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
    applyingExternal.current = false;
  }, [value]);

  return <div className="python-code-editor" data-testid="python-code-editor" ref={hostRef} />;
}
