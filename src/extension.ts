import * as vscode from 'vscode';

type TagInfo = {
  name: string;
  key: string;
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
  selfClosing: boolean;
  closing: boolean;
  nextIndex: number;
};

const SUPPORTED_LANGS = new Set(['html', 'javascriptreact', 'typescriptreact']);
const FRAGMENT_KEY = '__fragment__';

let colorDecorationTypes: vscode.TextEditorDecorationType[] = [];
let activeColors: string[] = [];
let ignoredTags = new Set<string>();
let pendingUpdate: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  loadConfiguration();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('rainbowTagsExtended.colors') ||
        event.affectsConfiguration('rainbowTagsExtended.ignoredTags')
      ) {
        loadConfiguration();
        triggerUpdate();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(triggerUpdate),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (vscode.window.activeTextEditor?.document === e.document) {
        triggerUpdate();
      }
    }),
  );

  triggerUpdate();
}

export function deactivate() {
  disposeDecorations();
}

function loadConfiguration() {
  const config = vscode.workspace.getConfiguration('rainbowTagsExtended');
  activeColors = config.get<string[]>('colors', [
    '#ff5555',
    '#ffb86c',
    '#f1fa8c',
    '#50fa7b',
    '#8be9fd',
    '#bd93f9',
    '#ff79c6',
  ]);
  ignoredTags = new Set((config.get<string[]>('ignoredTags', []) || []).map((t) => t.toLowerCase()));
  rebuildDecorations();
}

function rebuildDecorations() {
  disposeDecorations();
  colorDecorationTypes = activeColors.map((color) =>
    vscode.window.createTextEditorDecorationType({
      color,
      rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
    }),
  );
}

function disposeDecorations() {
  colorDecorationTypes.forEach((d) => d.dispose());
  colorDecorationTypes = [];
}

function triggerUpdate() {
  if (pendingUpdate) {
    clearTimeout(pendingUpdate);
  }
  pendingUpdate = setTimeout(() => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !SUPPORTED_LANGS.has(editor.document.languageId)) {
      return;
    }
    applyDecorations(editor);
  }, 10);
}

function applyDecorations(editor: vscode.TextEditor) {
  const doc = editor.document;
  const rangesByColorIndex = computeRanges(doc);

  colorDecorationTypes.forEach((decoration, idx) => {
    const ranges = rangesByColorIndex.get(idx) || [];
    editor.setDecorations(decoration, ranges);
  });
}

function computeRanges(document: vscode.TextDocument): Map<number, vscode.Range[]> {
  const text = document.getText();
  const stack: string[] = [];
  const ranges = new Map<number, vscode.Range[]>();

  let i = 0;
  let lineComment = false;
  let blockComment = false;
  let htmlComment = false;
  let stringQuote: string | null = null;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    // String handling
    if (stringQuote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        stringQuote = null;
      }
      i++;
      continue;
    }

    // Comment and string entry
    if (!lineComment && !blockComment && !htmlComment) {
      if (ch === '"' || ch === "'" || ch === '`') {
        stringQuote = ch;
        i++;
        continue;
      }
      if (ch === '/' && next === '/') {
        lineComment = true;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        blockComment = true;
        i += 2;
        continue;
      }
      if (ch === '<' && text.substr(i, 4) === '<!--') {
        htmlComment = true;
        i += 4;
        continue;
      }
    }

    if (lineComment) {
      if (ch === '\n') {
        lineComment = false;
      }
      i++;
      continue;
    }

    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (htmlComment) {
      if (ch === '-' && next === '-' && text[i + 2] === '>') {
        htmlComment = false;
        i += 3;
        continue;
      }
      i++;
      continue;
    }

    if (ch === '<') {
      const tag = readTag(text, i);
      if (!tag) {
        i++;
        continue;
      }

      // Skip TypeScript generics heuristically only for opening-like constructs
      // (closing tags must be allowed even when text directly precedes them).
      const prevChar = i > 0 ? text[i - 1] : ' ';
      const afterChar = tag.end + 1 < text.length ? text[tag.end + 1] : ' ';
      if (!tag.closing && /\w/.test(prevChar)) {
        i = tag.nextIndex;
        continue;
      }
      if (!tag.closing && tag.name && afterChar === '(') {
        i = tag.nextIndex;
        continue;
      }

      if (ignoredTags.has(tag.key)) {
        i = tag.nextIndex;
        continue;
      }

      const key = tag.key;
      if (!tag.closing) {
        const depth = stack.length + 1;
        addRanges(ranges, depth, document, tag);

        if (!tag.selfClosing) {
          stack.push(key);
        }
      } else {
        let depth = stack.length;
        let matchIndex = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s] === key) {
            matchIndex = s;
            break;
          }
        }
        if (matchIndex !== -1) {
          depth = matchIndex + 1;
          stack.splice(matchIndex, stack.length - matchIndex);
        } else {
          depth = Math.max(depth, 1);
        }

        if (depth > 0) {
          addRanges(ranges, depth, document, tag);
        }
      }

      i = tag.nextIndex;
      continue;
    }

    i++;
  }

  return ranges;
}

function addRanges(bucket: Map<number, vscode.Range[]>, depth: number, document: vscode.TextDocument, tag: TagInfo) {
  if (activeColors.length === 0) {
    return;
  }
  const colorIndex = (depth - 1) % activeColors.length;
  const ranges = bucket.get(colorIndex) || [];

  // Opening "<" (and optional "/" for closing tags)
  ranges.push(new vscode.Range(document.positionAt(tag.start), document.positionAt(tag.start + (tag.closing ? 2 : 1))));

  // Tag name
  if (tag.name.length > 0) {
    ranges.push(new vscode.Range(document.positionAt(tag.nameStart), document.positionAt(tag.nameEnd)));
  }

  // Closing angle bracket (includes "/>" when self-closing)
  const closingStart = tag.selfClosing ? tag.end - 1 : tag.end;
  ranges.push(new vscode.Range(document.positionAt(closingStart), document.positionAt(tag.end + 1)));

  bucket.set(colorIndex, ranges);
}

function readTag(text: string, start: number): TagInfo | null {
  let i = start + 1;
  let closing = false;
  if (text[i] === '/') {
    closing = true;
    i++;
  }

  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }

  // Shorthand fragments: "<>" or "</>"
  if (!closing && text[i] === '>') {
    return {
      name: '',
      key: FRAGMENT_KEY,
      start,
      end: i,
      nameStart: i,
      nameEnd: i,
      selfClosing: false,
      closing,
      nextIndex: i + 1,
    };
  }
  if (closing && text[i] === '>') {
    return {
      name: '',
      key: FRAGMENT_KEY,
      start,
      end: i,
      nameStart: i,
      nameEnd: i,
      selfClosing: false,
      closing,
      nextIndex: i + 1,
    };
  }

  const nameStart = i;
  // First character of a tag name must be a letter or underscore (prevents `< 10`)
  if (i >= text.length || !/[A-Za-z_]/.test(text[i])) {
    return null;
  }
  i++;
  while (i < text.length && /[A-Za-z0-9_.:-]/.test(text[i])) {
    i++;
  }
  const name = text.slice(nameStart, i);
  const key = name ? name.toLowerCase() : FRAGMENT_KEY;

  if (name.length === 0) {
    return null;
  }

  const nameEnd = nameStart + name.length;

  let inString: string | null = null;
  let braceDepth = 0; // for JSX expressions {...}
  let angleDepth = 0; // for generic parameters <T>
  let allowGenerics = true;

  while (i < text.length) {
    const ch = text[i];
    const nextCh = text[i + 1];

    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      i++;
      continue;
    }

    if (ch === '{') {
      braceDepth++;
      i++;
      continue;
    }
    if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth--;
      }
      i++;
      continue;
    }

    // Handle generic type parameters immediately after the name (TSX)
    if (allowGenerics && braceDepth === 0 && ch === '<') {
      angleDepth++;
      i++;
      continue;
    }
    if (angleDepth > 0) {
      if (ch === '<') {
        angleDepth++;
      } else if (ch === '>') {
        angleDepth--;
      }
      i++;
      continue;
    } else {
      allowGenerics = false; // once we leave the generic block, don't re-enter
    }

    if (braceDepth === 0) {
      if (ch === '/' && nextCh === '>') {
        return {
          name,
          key,
          start,
          end: i + 1,
          nameStart,
          nameEnd,
          selfClosing: true,
          closing,
          nextIndex: i + 2,
        };
      }
      if (ch === '>') {
        return {
          name,
          key,
          start,
          end: i,
          nameStart,
          nameEnd,
          selfClosing: false,
          closing,
          nextIndex: i + 1,
        };
      }
    }

    i++;
  }

  return null;
}
