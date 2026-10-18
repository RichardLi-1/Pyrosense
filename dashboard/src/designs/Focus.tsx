// Focus: the map is the screen. One big reading floats over it; everything else is quiet.
import { useCallback, useState } from 'react'
import MapStage from '../map/MapStage'
import { THEMES } from '../map/theme'
import { SCALE } from '../lib/colors'
import Logo from '../ui/Logo'
import { AlertBanner, Attitude, Crew, PlaybackToggle, Reading, SensorTiles, Sparkline, SourceToggle, Status, Timeline, Waiting, useNow } from '../ui/parts'
import type { DesignProps } from './types'

export default function Focus({ s, setUntil, view, select, setSource, gas }: DesignProps) {
  const now = useNow()
  const [playback, setPlaybackState] = useState(false)
  const setPlayback = useCallback((on: boolean) => { setPlaybackState(on); if (!on) setUntil(null) }, [setUntil])
  return (
    <div className="design d-focus">
      <MapStage theme={THEMES.focus} meta={s.meta} image={s.image} heat={s.heat} trail={s.trail} pose={s.pose} poses={s.poses} selected={s.selected!}
               alerts={s.alerts} threshold={s.threshold} {...view} gas={gas} inset={{ left: 280, top: 40, bottom: playback ? 70 : 20 }} />
      <Waiting s={s} />
      <header className="f-top">
        <span className="brand"><Logo height={60} /></span>
        <div className="row"><Status s={s} /><PlaybackToggle on={playback} set={setPlayback} /><SourceToggle kind={s.kind} setSource={setSource} /></div>
      </header>
      <section className="f-reading">
        <span className="caption">{SCALE.label}</span>
        <Reading voc={s.voc} />
        <Sparkline points={s.window} />
        <Attitude pose={s.pose} />
        <SensorTiles s={s} gas={gas} />
        <Crew s={s} select={select} colors={THEMES.focus.crew} />
      </section>
      <AlertBanner alerts={s.alerts} now={now} crew={s.crew.length} />
      {playback && <footer className="f-bottom"><Timeline s={s} now={now} setUntil={setUntil} /></footer>}
    </div>
  )
}
