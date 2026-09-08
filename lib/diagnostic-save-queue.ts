import {
  diagnosticFinished,
  type DiagnosticRun,
  type DiagnosticRunSummary,
} from './diagnostic-runs';

export type DiagnosticSaveStatus = {
  state: 'saving' | 'saved' | 'error';
  message?: string;
};
type Entry = {
  json: string;
  saved: string;
  revision: number;
  busy: boolean;
  failed: boolean;
};

// One save at a time per run: a review edited during a save is sent next.
// Retries reuse the same revision, making uncertain responses safe to retry.
export class DiagnosticSaveQueue {
  private entries = new Map<string, Entry>();
  private revision = Date.now();
  constructor(
    private send: (
      document: DiagnosticRun,
      revision: number,
    ) => Promise<DiagnosticRunSummary>,
    private status: (id: string, status: DiagnosticSaveStatus) => void,
    private saved: (run: DiagnosticRunSummary) => void,
  ) {}
  update(document: DiagnosticRun) {
    if (!diagnosticFinished(document)) return;
    const json = JSON.stringify(document);
    let entry = this.entries.get(document.id);
    if (entry?.json === json) return;
    if (!entry) {
      entry = { json: '', saved: '', revision: 0, busy: false, failed: false };
      this.entries.set(document.id, entry);
    }
    entry.json = json;
    entry.revision = ++this.revision;
    entry.failed = false;
    void this.flush(document.id, entry);
  }
  retry(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.failed = false;
    void this.flush(id, entry);
  }
  private async flush(id: string, entry: Entry) {
    if (entry.busy) return;
    entry.busy = true;
    while (!entry.failed && entry.json !== entry.saved) {
      const json = entry.json;
      const revision = entry.revision;
      this.status(id, { state: 'saving' });
      try {
        const summary = await this.send(JSON.parse(json), revision);
        entry.saved = json;
        this.saved(summary);
      } catch (error) {
        // A newer review can still be saved if the previous revision failed.
        if (entry.json !== json) continue;
        entry.failed = true;
        this.status(id, {
          state: 'error',
          message:
            error instanceof Error ? error.message : 'Could not save this run.',
        });
      }
    }
    entry.busy = false;
    if (!entry.failed) this.status(id, { state: 'saved' });
  }
}
