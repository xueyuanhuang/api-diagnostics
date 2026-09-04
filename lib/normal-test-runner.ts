export type NormalQuestion = {
  id: string;
  category: string;
  prompt: string;
};

export type NormalResultStatus =
  | 'waiting'
  | 'running'
  | 'stopped'
  | 'normal'
  | 'cached'
  | 'large'
  | 'unavailable'
  | 'error';

export type NormalRunResult<TData extends object> = NormalQuestion &
  Partial<TData> & {
    status: NormalResultStatus;
    error?: string | null;
  };

type ExecuteNormalTestRunOptions<TData extends object> = {
  questions: readonly NormalQuestion[];
  signal: AbortSignal;
  request: (
    question: NormalQuestion,
    index: number,
    signal: AbortSignal,
  ) => Promise<TData>;
  classify: (
    data: TData,
  ) => Exclude<NormalResultStatus, 'waiting' | 'running' | 'stopped'>;
  publish: (results: NormalRunResult<TData>[]) => void;
};

function snapshot<TData extends object>(results: NormalRunResult<TData>[]) {
  return results.map((result) => ({ ...result }));
}

function stoppedSnapshot<TData extends object>(
  results: NormalRunResult<TData>[],
) {
  return results.map((result) =>
    result.status === 'waiting' || result.status === 'running'
      ? { ...result, status: 'stopped' as const }
      : { ...result },
  );
}

function pendingResult<TData extends object>(
  question: NormalQuestion,
  status: 'waiting' | 'running',
) {
  return { ...question, status } as NormalRunResult<TData>;
}

function completedResult<TData extends object>(
  question: NormalQuestion,
  data: TData,
  status: Exclude<NormalResultStatus, 'waiting' | 'running' | 'stopped'>,
) {
  return { ...question, ...data, status } as NormalRunResult<TData>;
}

function errorResult<TData extends object>(
  question: NormalQuestion,
  error: unknown,
) {
  return {
    ...question,
    status: 'error',
    error: error instanceof Error ? error.message : 'Unknown request error.',
  } as NormalRunResult<TData>;
}

export async function executeNormalTestRun<TData extends object>({
  questions,
  signal,
  request,
  classify,
  publish,
}: ExecuteNormalTestRunOptions<TData>) {
  let results: NormalRunResult<TData>[] = questions.map((question) =>
    pendingResult<TData>(question, 'waiting'),
  );
  publish(snapshot(results));

  for (let index = 0; index < questions.length; index += 1) {
    if (signal.aborted) {
      results = stoppedSnapshot(results);
      publish(snapshot(results));
      return { stopped: true, results };
    }

    const question = questions[index];
    results[index] = pendingResult<TData>(question, 'running');
    publish(snapshot(results));
    try {
      const data = await request(question, index, signal);
      results[index] = completedResult(question, data, classify(data));
    } catch (error) {
      if (signal.aborted) {
        results = stoppedSnapshot(results);
        publish(snapshot(results));
        return { stopped: true, results };
      }
      results[index] = errorResult<TData>(question, error);
    }
    publish(snapshot(results));
  }

  if (signal.aborted) {
    results = stoppedSnapshot(results);
    publish(snapshot(results));
    return { stopped: true, results };
  }
  return { stopped: false, results };
}
