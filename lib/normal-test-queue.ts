import {
  executeNormalTestRun,
  type ExecuteNormalTestRunOptions,
  type NormalRunResult,
} from './normal-test-runner';

export type QueuePhase =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'saving'
  | 'complete';
export type NormalQueueJob<T extends object, C extends object> = {
  id: string;
  key: string;
  context: C;
  phase: QueuePhase;
  results: NormalRunResult<T>[];
  message: string;
};
type Task<T extends object, C extends object> = Pick<
  ExecuteNormalTestRunOptions<T>,
  'questions' | 'request' | 'classify'
> & {
  key: string;
  context: C;
  save?: (results: NormalRunResult<T>[], context: C) => Promise<C>;
};
export function isQueueActive(phase: QueuePhase) {
  return ['queued', 'running', 'stopping', 'saving'].includes(phase);
}

// Each task owns its request closure and controller. Credentials never enter
// public snapshots, and completed/cancelled tasks release their closures.
export class NormalTestQueue<T extends object, C extends object> {
  private jobs: NormalQueueJob<T, C>[] = [];
  private tasks = new Map<string, Task<T, C>>();
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private serial = 0;
  private concurrency = 3;
  getSnapshot = () => this.jobs;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private update(id: string, patch: Partial<NormalQueueJob<T, C>>) {
    this.jobs = this.jobs.map((job) =>
      job.id === id ? { ...job, ...patch } : job,
    );
    this.emit();
  }
  setConcurrency(value: number) {
    this.concurrency = Math.max(1, Math.min(6, Math.floor(value) || 3));
    this.pump();
  }
  enqueue(tasks: Task<T, C>[]) {
    const added: string[] = [];
    for (const task of tasks) {
      if (
        this.jobs.some(
          (job) => job.key === task.key && isQueueActive(job.phase),
        )
      )
        continue;
      const id = `model-job-${++this.serial}`;
      this.tasks.set(id, task);
      this.jobs = [
        ...this.jobs,
        {
          id,
          key: task.key,
          context: { ...task.context },
          phase: 'queued',
          results: task.questions.map((q) => ({
            ...q,
            status: 'waiting',
          })) as NormalRunResult<T>[],
          message: 'Waiting for an available model slot.',
        },
      ];
      added.push(id);
    }
    this.emit();
    this.pump();
    return added;
  }
  private pump() {
    while (this.controllers.size < this.concurrency) {
      const job = this.jobs.find((item) => item.phase === 'queued');
      if (!job) break;
      const task = this.tasks.get(job.id);
      if (!task) break;
      const controller = new AbortController();
      this.controllers.set(job.id, controller);
      this.update(job.id, {
        phase: 'running',
        message: 'Running 12 questions, one at a time for this model…',
      });
      void this.run(job, task, controller);
    }
  }
  private async run(
    job: NormalQueueJob<T, C>,
    task: Task<T, C>,
    controller: AbortController,
  ) {
    try {
      const outcome = await executeNormalTestRun<T>({
        questions: task.questions,
        request: task.request,
        classify: task.classify,
        signal: controller.signal,
        publish: (results) => this.update(job.id, { results }),
      });
      if (outcome.stopped) {
        this.update(job.id, {
          phase: 'stopped',
          message:
            'Stopped. Partial evidence remains available to export; no partial run was saved automatically.',
        });
      } else if (task.save) {
        this.update(job.id, {
          phase: 'saving',
          message: 'Saving this model to your private history…',
        });
        try {
          const context = await task.save(outcome.results, job.context);
          this.update(job.id, {
            phase: 'complete',
            context,
            message: 'Complete and saved to your private history.',
          });
        } catch (error) {
          this.update(job.id, {
            phase: 'complete',
            message: `Complete, but saving failed: ${error instanceof Error ? error.message : 'unknown error'}. Export this model’s evidence before leaving.`,
          });
        }
      } else {
        this.update(job.id, {
          phase: 'complete',
          message:
            'Complete. Not saved — sign in to save future runs. Evidence can be exported now.',
        });
      }
    } catch (error) {
      this.update(job.id, {
        phase: 'stopped',
        message: `Tester interrupted: ${error instanceof Error ? error.message : 'unknown error'}. Partial evidence retained.`,
      });
    } finally {
      this.tasks.delete(job.id);
      this.controllers.delete(job.id);
      this.pump();
    }
  }
  stop(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || job.phase === 'saving' || !isQueueActive(job.phase)) return;
    if (job.phase === 'queued') {
      this.tasks.delete(id);
      this.update(id, {
        phase: 'stopped',
        results: job.results.map((r) => ({ ...r, status: 'stopped' })),
        message: 'Cancelled before starting. No requests sent.',
      });
    } else {
      this.update(id, { phase: 'stopping', message: 'Stopping this model…' });
      this.controllers.get(id)?.abort();
    }
  }
  stopAll() {
    // Cancel all waiting jobs before aborting active jobs to prevent queue refill.
    for (const job of this.jobs.filter((j) => j.phase === 'queued'))
      this.stop(job.id);
    for (const job of this.jobs.filter((j) => j.phase === 'running'))
      this.stop(job.id);
  }
  clear() {
    if (this.controllers.size || this.jobs.some((j) => isQueueActive(j.phase)))
      return;
    this.jobs = [];
    this.tasks.clear();
    this.emit();
  }
}
