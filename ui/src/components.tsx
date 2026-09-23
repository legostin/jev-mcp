import { useState } from 'preact/hooks';

export function Badge({ value }: { value?: string | null }) {
  return <span class={`badge ${value ?? ''}`}>{(value ?? '—').replace('_', ' ')}</span>;
}

export function Json({ value, open = false, label = 'JSON' }: { value: unknown; open?: boolean; label?: string }) {
  const [show, setShow] = useState(open);
  return (
    <div>
      <a href="#" onClick={(e) => { e.preventDefault(); setShow(!show); }}>{show ? '▾' : '▸'} {label}</a>
      {show && <pre>{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

/** Probability bars for a JEV answer, with act/escalate threshold markers for choices. */
export function AnswerView({ id, answer, thresholds, labels }: {
  id: string; answer: any; thresholds?: { act: number; escalate: number }; labels?: Record<string, string>;
}) {
  if (!answer) return null;
  if (answer.type === 'noul') {
    return (
      <div class="bars">
        <div class="muted small">{id} · noul</div>
        <Bar label="yes" p={answer.noul} top={answer.noul >= 0.5} />
      </div>
    );
  }
  const probs = Object.entries(answer.probabilities as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return (
    <div class="bars">
      <div class="muted small">
        {id} · {answer.type} · confidence <b>{answer.confidence?.toFixed(2)}</b>
        {thresholds && <> · act ≥ {thresholds.act} · ask &lt; {thresholds.escalate}</>}
        {answer.type === 'score' && <> · score {answer.score?.toFixed(2)}</>}
      </div>
      {probs.map(([k, p]) => (
        <Bar label={answer.type === 'score' ? `${k}: ${answer.legend?.[k] ?? ''}` : `${k}${labels?.[k] ? ` ${labels[k]}` : ''}`} p={p}
          top={answer.type === 'choice' ? k === answer.choice : false} />
      ))}
      {thresholds && answer.type === 'choice' && (
        <div class="bar"><span class="label muted small">confidence</span>
          <div class="track">
            <div class="fill" style={{ width: `${(answer.confidence ?? 0) * 100}%`, opacity: 0.6 }} />
            <div class="marker act" style={{ left: `${thresholds.act * 100}%` }} title="act" />
            <div class="marker esc" style={{ left: `${thresholds.escalate * 100}%` }} title="escalate" />
          </div>
          <span>{answer.confidence?.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}

function Bar({ label, p, top }: { label: string; p: number; top: boolean }) {
  return (
    <div class={`bar ${top ? 'top' : ''}`}>
      <span class="label" title={label}>{label}</span>
      <div class="track"><div class="fill" style={{ width: `${Math.max(0.5, p * 100)}%` }} /></div>
      <span>{(p * 100).toFixed(1)}%</span>
    </div>
  );
}

export function Modal({ children, onClose }: { children: any; onClose: () => void }) {
  return <div class="modal" onClick={onClose}>{children}</div>;
}
