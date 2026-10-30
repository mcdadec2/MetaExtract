import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import '../../assets/base.css';
import { formatBytes } from '../../lib/format';
import { ACTIVE_STATES, type Job } from '../../lib/jobs';
import { sendRequest, type BackgroundEvent } from '../../lib/messages';
import './style.css';

const STATE_LABEL: Record<Job['state'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  merging: 'Merging video and audio',
  saving: 'Saving',
  done: 'Saved',
  failed: 'Failed',
  canceled: 'Canceled',
};

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function JobRow({ job }: { job: Job }) {
  const active = ACTIVE_STATES.has(job.state);
  const percent = job.progress === undefined ? undefined : Math.round(job.progress * 100);
  const details = [
    STATE_LABEL[job.state] + (job.state === 'downloading' && percent !== undefined ? ` · ${percent}%` : ''),
    job.bytes ? formatBytes(job.bytes) : undefined,
    job.renditionLabel,
  ].filter(Boolean);

  return (
    <li class="job" data-state={job.state}>
      <div class="title" title={job.filename}>
        {job.candidate.pageTitle || fileName(job.filename)}
      </div>
      <div class="file">{fileName(job.filename)}</div>
      {job.state === 'downloading' || job.state === 'merging' ? (
        <progress max={1} value={job.state === 'merging' ? undefined : job.progress} />
      ) : null}
      <div class="details">{details.join(' · ')}</div>
      {job.error && <div class="error">{job.error}</div>}
      <div class="actions">
        {active && <button onClick={() => void sendRequest({ type: 'jobs/cancel', id: job.id })}>Cancel</button>}
        {(job.state === 'failed' || job.state === 'canceled') && (
          <button onClick={() => void sendRequest({ type: 'jobs/retry', id: job.id })}>Retry</button>
        )}
        {job.state === 'done' && (
          <button onClick={() => void sendRequest({ type: 'jobs/show', id: job.id })}>Show in folder</button>
        )}
      </div>
    </li>
  );
}

function App() {
  const [jobs, setJobs] = useState<Job[]>();

  useEffect(() => {
    void sendRequest({ type: 'jobs/list' }).then(setJobs);
    const onMessage = (message: BackgroundEvent) => {
      if (message?.type === 'jobs/changed') setJobs(message.jobs);
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

  const hasFinished = jobs?.some((job) => !ACTIVE_STATES.has(job.state));

  return (
    <main>
      <header>
        <h1>Downloads</h1>
        {hasFinished && (
          <button class="link" onClick={() => void sendRequest({ type: 'jobs/clear' })}>
            Clear finished
          </button>
        )}
      </header>
      {jobs === undefined ? (
        <p class="empty">Loading…</p>
      ) : jobs.length === 0 ? (
        <p class="empty">Nothing yet. Pick a video in the MetaExtract popup to download it.</p>
      ) : (
        <ul class="jobs">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      )}
    </main>
  );
}

render(<App />, document.getElementById('app')!);
