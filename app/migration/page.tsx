'use client';
import {useState} from 'react';

export default function MigrationPage(){
  const [url,setUrl]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState(false);
  return <main className="mx-auto max-w-xl space-y-5 px-6 py-12">
    <h1 className="text-2xl font-bold">Import original connections</h1>
    <p>If your browser cannot follow the original website’s return link, paste that link here while signed into the same Google account.</p>
    <form className="space-y-4" onSubmit={async event=>{event.preventDefault();setBusy(true);setStatus('Importing…');try{const response=await fetch('/migration/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});if(!response.ok)throw new Error(await response.text());setDone(true);setUrl('');setStatus('Connections imported into your Google account.');}catch(error){setStatus(error instanceof Error?error.message:'Import failed.');}finally{setBusy(false);}}}>
      <label className="block">Transfer return link<input type="url" required autoComplete="off" value={url} onChange={e=>setUrl(e.target.value)} className="mt-2 w-full rounded-lg border p-3"/></label>
      <button disabled={busy||done} className="rounded-lg bg-primary px-4 py-3 text-primary-foreground">Import connections</button>
    </form>
    <p role="status">{status}</p>
    <a href="/connections" className="underline">Open connections</a>
  </main>;
}
