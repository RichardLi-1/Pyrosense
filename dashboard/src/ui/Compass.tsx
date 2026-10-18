// A small compass rose. North-up in 2D; the 3D view rotates it with the camera via `ref`.
import { forwardRef } from 'react'

const Compass = forwardRef<SVGSVGElement, { size?: number; className?: string }>(function Compass({ size = 56, className }, ref) {
  const r = size / 2
  return (
    <svg ref={ref} className={`compass${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 56 56" aria-label="Compass">
      <circle cx="28" cy="28" r="26" fill="var(--compass-bg)" stroke="var(--line)" />
      <circle cx="28" cy="28" r="18" fill="none" stroke="var(--line)" />
      <path d="M28 6 L31.5 24 L28 28 L24.5 24 Z" fill="var(--alert)" />
      <path d="M28 50 L31.5 32 L28 28 L24.5 32 Z" fill="var(--muted)" opacity=".7" />
      <path d="M6 28 L24 24.5 L28 28 L24 31.5 Z M50 28 L32 24.5 L28 28 L32 31.5 Z" fill="var(--muted)" opacity=".45" />
      <g fontFamily="Inter, system-ui, sans-serif" fontSize="8" fontWeight="700" textAnchor="middle" fill="var(--text)">
        <text x="28" y="12.5">N</text><text x="45.5" y="30.8">E</text><text x="28" y="48.5">S</text><text x="10.5" y="30.8">W</text>
      </g>
      <circle cx="28" cy="28" r="1.6" fill="var(--text)" />
    </svg>
  )
})
export default Compass
