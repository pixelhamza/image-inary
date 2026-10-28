import { useEffect, useRef } from 'react'

export function downloadName(name: string): string {
  return name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 255) || 'photo'
}

export default function OriginalPreview({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  return (
    <dialog ref={dialog} aria-labelledby="preview-title" onCancel={(event) => { event.preventDefault(); onClose() }} className="m-auto max-h-[90vh] w-[min(90vw,1000px)] rounded-2xl border border-stone-200 bg-white p-5 backdrop:bg-black/70">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 id="preview-title" className="truncate font-semibold">{name}</h2>
        <button autoFocus onClick={onClose} className="rounded-lg border px-3 py-2 text-sm">Close preview</button>
      </div>
      <img src={url} alt={name} className="max-h-[65vh] w-full object-contain" />
      <a href={url} download={downloadName(name)} className="mt-4 inline-block rounded-lg bg-emerald-900 px-4 py-2 text-sm font-semibold text-white">Download original</a>
    </dialog>
  )
}
