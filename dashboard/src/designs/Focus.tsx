// Focus: the map is the screen. One big reading floats over it; everything else is quiet.
import { useCallback, useState } from 'react'
import MapStage from '../map/MapStage'
import { THEMES } from '../map/theme'
import { SCALE } from '../lib/colors'
import Logo from '../ui/Logo'
import { RestartScan, SaveScan, ScansButton } from '../ui/scans'
import { AlertBanner, Attitude, Crew, PlaybackToggle, Reading, SensorTiles, Sparkline, SourceToggle, Status, Timeline, Waiting, useNow } from '../ui/parts'
import type { DesignProps } from './types'

export default function Focus({ s, setUntil, view, select, setSource, gas, scans }: DesignProps) {
  const now = useNow()
  const [playback, setPlaybackState] = useState(false)
  const setPlayback = useCallback((on: boolean) => { setPlaybackState(on); if (!on) setUntil(null) }, [setUntil])
  const review = s.reviewing
  const scrubber = playback || !!review
  const reviewEnd = review ? (review.ended ? Date.parse(review.ended) : undefined) : undefined
  return (
    <div className="design d-focus">
      <MapStage theme={THEMES.focus} meta={s.meta} image={s.image} heat={s.heat} trail={s.trail} pose={s.pose} poses={s.poses} selected={s.selected!}
               alerts={s.alerts} threshold={s.threshold} voc={s.voc} {...view} gas={gas} inset={{ left: 390, top: 88, bottom: scrubber ? 124 : 72 }} />
      <Waiting s={s} />
      <header className="f-top">
        <a className="brand" href="/landing/" title="About this project"><Logo height={60} /></a>
        <div className="row">
          <Status s={s} />
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
        <Crew s={s} select={select} colors={THEMES.focus.crew} />
      </section>
      <AlertBanner alerts={s.alerts} now={now} crew={s.crew.length} />
      {scrubber && <footer className="f-bottom">
        <Timeline s={s} now={now} setUntil={setUntil} end={reviewEnd} onLive={review ? { label: 'back to live', go: scans.close } : undefined} />
      </footer>}
    </div>
  )
}
