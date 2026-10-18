// Focus: the map is the screen. One big reading floats over it; everything else is quiet.
import { useCallback, useState } from 'react'
import MapStage from '../map/MapStage'
import { THEMES } from '../map/theme'
import type { LayerKey } from '../map/layers'
import { SCALE } from '../lib/colors'
import { useMarks, type MarkKind } from '../lib/marks'
import { responderLabel } from '../lib/types'
import Logo from '../ui/Logo'
import { AnnotateBar } from '../ui/Annotate'
import { ExposurePanel, ExposureToggle } from '../ui/Exposure'
import { RestartScan, SaveScan, ScansButton } from '../ui/scans'
import { AlertBanner, Attitude, Crew, PlaybackToggle, Reading, SensorTiles, Sparkline, SourceToggle, Status, Timeline, Waiting, useNow } from '../ui/parts'
import type { DesignProps } from './types'

export default function Focus({ s, setUntil, view, setView, select, setSource, gas, scans }: DesignProps) {
  const now = useNow()
  const [playback, setPlaybackState] = useState(false)
  const setPlayback = useCallback((on: boolean) => { setPlaybackState(on); if (!on) setUntil(null) }, [setUntil])
  const [exposure, setExposure] = useState(false)
  const review = s.reviewing
  const scrubber = playback || !!review
  const reviewEnd = review ? (review.ended ? Date.parse(review.ended) : undefined) : undefined

  const setLayer = useCallback((k: LayerKey, on: boolean) => setView((v) => ({ ...v, layers: { ...v.layers, [k]: on } })), [setView])
  const setFollow = useCallback((on: boolean) => setView((v) => ({ ...v, follow: on })), [setView])
  const setOnly = useCallback((only: string | null) => setView((v) => ({ ...v, only })), [setView])
  // picking from the exposure panel: show that responder, keeping "All" if it's on
  const pickResponder = useCallback((id: string) => { select(id); setView((v) => (v.only ? { ...v, only: id } : v)) }, [select, setView])

  // commander's marks: arm a kind, then click the map (or drop it at the selected responder)
  const { marks, add, remove } = useMarks(s.session)
  const [armed, setArmedState] = useState<MarkKind | null>(null)
  const setArmed = useCallback((k: MarkKind | null) => {
    setArmedState(k)
    if (k) setLayer('marks', true) // a new mark should be visible
  }, [setLayer])
  const by = s.crew.length > 1 ? responderLabel(s.crew, s.selected!) : undefined
  const onPick = useCallback((x: number, y: number) => {
    if (armed) add({ kind: armed, x, y, by })
    setArmedState(null)
  }, [armed, add, by])
  const here = s.pose ? { label: responderLabel(s.crew, s.selected!), x: s.pose.x, y: s.pose.y } : null
  const dropHere = useCallback(() => {
    if (armed && here) add({ kind: armed, x: here.x, y: here.y, by: here.label })
    setArmedState(null)
  }, [armed, here, add])

  return (
    <div className="design d-focus">
      <MapStage theme={THEMES.focus} meta={s.meta} image={s.image} heat={s.heat} trail={s.trail} pose={s.pose} poses={s.poses} selected={s.selected!}
                alerts={s.alerts} threshold={s.threshold} voc={s.voc} follow={view.follow} layers={view.layers} only={view.only} crew={s.crew}
                marks={marks} onPick={armed ? onPick : null} setLayer={setLayer} setFollow={setFollow}
                gas={gas} inset={{ left: 390, top: 88, right: 104, bottom: scrubber ? 124 : 72 }} />
      <Waiting s={s} />
      <header className="f-top">
        <a className="brand" href="/landing/" title="About this project"><Logo height={60} /></a>
        <div className="row">
          <Status s={s} />
          <ExposureToggle on={exposure} set={setExposure} />
          {review
            ? <button className="map-btn solid" onClick={scans.close}>Back to live</button>
            : <PlaybackToggle on={playback} set={setPlayback} />}
          {scans.supported && !review && <><SaveScan scans={scans} /><RestartScan scans={scans} /></>}
          {scans.supported && <ScansButton scans={scans} current={review ? '' : s.session} reviewing={review} />}
          <SourceToggle kind={s.kind} setSource={setSource} />
        </div>
      </header>
      <section className="f-reading">
        <span className="caption">{SCALE.label}</span>
        <Reading voc={s.voc} />
        <Sparkline points={s.window} width={340} height={28} />
        <Attitude pose={s.pose} />
        <SensorTiles s={s} gas={gas} />
        <Crew s={s} select={select} colors={THEMES.focus.crew} only={view.only} setOnly={setOnly} />
      </section>
      <AnnotateBar marks={marks} armed={armed} setArmed={setArmed} remove={remove} here={here} dropHere={dropHere} now={now} />
      {exposure && <ExposurePanel s={s} now={now} colors={THEMES.focus.crew} pick={pickResponder} close={() => setExposure(false)} />}
      <AlertBanner alerts={s.alerts} now={now} crew={s.crew} />
      {scrubber && <footer className="f-bottom">
        <Timeline s={s} now={now} setUntil={setUntil} end={reviewEnd} onLive={review ? { label: 'back to live', go: scans.close } : undefined} />
      </footer>}
    </div>
  )
}
