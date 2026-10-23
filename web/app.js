// UI for the converter. The actual work happens in worker.js.

const $ = (id) => document.getElementById(id);
const canPickFolder = 'showDirectoryPicker' in window;
const OPFS_WORK_DIR = 'ninox-csv';

let file = null;
let worker = null;
let zipResult = null;
let startedAt = 0;

// prefer writing straight to a folder where the browser supports it
document.querySelector(`input[name=mode][value=${canPickFolder ? 'folder' : 'zip'}]`).checked = true;
if (!canPickFolder) {
  document.querySelector('input[name=mode][value=folder]').disabled = true;
  $('folder-label').classList.add('disabled');
  $('folder-note').textContent = '(not supported in this browser, use Chrome or Edge)';
}

// remove leftovers of an earlier ZIP conversion from browser storage
navigator.storage?.getDirectory?.()
  .then((root) => root.removeEntry(OPFS_WORK_DIR, { recursive: true }))
  .catch(() => {});

$('drop').addEventListener('click', () => $('file').click());
$('drop').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); }
});
$('file').addEventListener('change', () => selectFile($('file').files[0]));
$('drop').addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('over'); });
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('over');
  selectFile(e.dataTransfer.files[0]);
});

$('start').addEventListener('click', start);
$('cancel').addEventListener('click', () => finish('Cancelled.', 'error'));
$('download').addEventListener('click', download);

function selectFile(selected) {
  if (!selected) return;
  file = selected;
  $('file-name').textContent = file.name;
  $('file-info').textContent = formatBytes(file.size);
  $('start').disabled = false;
}

async function start() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  let dirHandle = null;
  if (mode === 'folder') {
    try {
      dirHandle = await window.showDirectoryPicker({ id: 'ninox-csv', mode: 'readwrite' });
    } catch {
      return; // picker dismissed
    }
  }

  zipResult = null;
  $('result-card').hidden = true;
  $('progress-card').hidden = false;
  $('start').disabled = true;
  $('cancel').hidden = false;
  setProgress('Reading backup…', 0, '');
  startedAt = performance.now();

  worker = new Worker('worker.js');
  worker.onmessage = (e) => onMessage(e.data);
  worker.onerror = (e) => finish(`Unexpected error: ${e.message}`, 'error');
  worker.postMessage({ file, mode, dirHandle, bom: $('bom').checked });
}

function onMessage(msg) {
  if (msg.type === 'progress' && msg.phase === 'convert') {
    const seconds = (performance.now() - startedAt) / 1000;
    const speed = seconds > 0 ? ` · ${formatBytes(msg.done / seconds)}/s` : '';
    setProgress('Converting…', msg.done / msg.total,
      `${formatBytes(msg.done)} of ${formatBytes(msg.total)}${speed} · ${msg.records.toLocaleString()} records · ${msg.tables} tables`);
  } else if (msg.type === 'progress' && msg.phase === 'zip') {
    setProgress('Packing ZIP…', msg.total ? msg.done / msg.total : 1, `${formatBytes(msg.done)} of ${formatBytes(msg.total)}`);
  } else if (msg.type === 'done') {
    showResult(msg);
  } else if (msg.type === 'error') {
    finish(msg.message, 'error');
  }
}

function showResult({ result, stats, tables, seconds }) {
  const notes = [];
  if (stats.unknownTable) notes.push(`${stats.unknownTable.toLocaleString()} records of deleted tables skipped`);
  if (stats.invalidLines) notes.push(`${stats.invalidLines.toLocaleString()} unreadable lines skipped`);
  const where = result.type === 'folder' ? ` into folder “${result.folder}”` : '';
  finish(`Wrote ${tables.length} CSV files with ${stats.records.toLocaleString()} records${where} in ${seconds.toFixed(1)} s.`
    + (notes.length ? ` (${notes.join(', ')})` : ''), 'ok');

  const body = $('tables').querySelector('tbody');
  body.replaceChildren(...tables.map((t) => {
    const row = document.createElement('tr');
    for (const value of [t.caption, t.file, t.rows.toLocaleString()]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  $('tables').hidden = tables.length === 0;

  if (result.type === 'zip') {
    zipResult = result;
    $('download').hidden = false;
    download();
  }
}

// the ZIP lives in the origin private file system, so the File object is backed by disk and can be any size
async function download() {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(zipResult.opfsDir);
  const zipFile = await (await dir.getFileHandle(zipResult.fileName)).getFile();
  const url = URL.createObjectURL(zipFile);
  const link = document.createElement('a');
  link.href = url;
  link.download = zipResult.fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function finish(message, kind) {
  worker?.terminate();
  worker = null;
  $('progress-card').hidden = true;
  $('result-card').hidden = false;
  $('download').hidden = true;
  $('tables').hidden = true;
  $('result').className = kind;
  $('result').textContent = message;
  $('start').disabled = !file;
  $('cancel').hidden = true;
}

function setProgress(phase, fraction, status) {
  $('phase').textContent = phase;
  $('bar').style.width = `${Math.min(100, Math.max(0, fraction * 100)).toFixed(1)}%`;
  $('status').textContent = status;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}
