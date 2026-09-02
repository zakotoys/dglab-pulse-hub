import gsap from 'gsap';

export function withMotionPreferences(animate: (reducedMotion: boolean) => void): () => void {
  const media = gsap.matchMedia();
  media.add(
    {
      reduceMotion: '(prefers-reduced-motion: reduce)',
      noPreference: '(prefers-reduced-motion: no-preference)'
    },
    ({ conditions }) => {
      animate(conditions?.reduceMotion === true);
    }
  );
  return () => media.revert();
}

export function animateWorkspaceIntro(root: Element, reducedMotion: boolean): void {
  if (reducedMotion) return;
  const timeline = gsap.timeline({ defaults: { ease: 'power3.out' } });
  const topbar = root.querySelector('.topbar');
  const sidebar = root.querySelector('.sidebar');
  const content = root.querySelector('.content');

  if (topbar !== null) timeline.from(topbar, { autoAlpha: 0, y: -10, duration: 0.35 });
  if (sidebar !== null) timeline.from(sidebar, { autoAlpha: 0, x: -14, duration: 0.42 }, '<0.08');
  if (content !== null) timeline.from(content, { autoAlpha: 0, y: 12, duration: 0.42 }, '<0.08');
  timeline.from(
    root.querySelectorAll('.sidebar-block'),
    { autoAlpha: 0, y: 8, duration: 0.26, stagger: 0.04 },
    '<0.08'
  );
}

export function animateResultPanels(root: Element, reducedMotion: boolean): void {
  if (reducedMotion) return;
  const panels = root.querySelectorAll('[data-motion-panel]');
  if (panels.length === 0) return;
  gsap.from(panels, {
    autoAlpha: 0,
    y: 14,
    duration: 0.42,
    ease: 'power2.out',
    stagger: { each: 0.06, from: 'start' },
    overwrite: 'auto'
  });
}

export function animateDiagnostics(root: Element, reducedMotion: boolean): void {
  if (reducedMotion) return;
  const diagnostics = root.querySelector('.diagnostics');
  if (diagnostics === null) return;
  const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } });
  timeline.from(diagnostics, { autoAlpha: 0, y: 8, duration: 0.3 });
  timeline.from(
    diagnostics.querySelectorAll('.diagnostic'),
    { autoAlpha: 0, x: -8, duration: 0.24, stagger: 0.04 },
    '<0.08'
  );
}

export function animateTimeline(root: Element, reducedMotion: boolean): void {
  if (reducedMotion) return;
  const lines = root.querySelectorAll('.timeline-panel .line');
  if (lines.length > 0) {
    gsap.from(lines, {
      autoAlpha: 0,
      y: 8,
      duration: 0.5,
      ease: 'power2.out',
      stagger: 0.08,
      overwrite: 'auto'
    });
  }
  const cursor = root.querySelector('.timeline-panel .cursor');
  if (cursor !== null)
    gsap.from(cursor, {
      autoAlpha: 0,
      scaleY: 0.7,
      transformOrigin: 'center top',
      duration: 0.3,
      ease: 'power2.out'
    });
}

export function animateIntensityRing(
  root: Element,
  fromValue: number,
  toValue: number,
  reducedMotion: boolean
): void {
  if (reducedMotion) return;
  const ring = root.querySelector('.intensity-ring');
  if (ring === null) return;
  gsap.fromTo(
    ring,
    { '--intensity-value': fromValue + '%', scale: 0.96 },
    {
      '--intensity-value': toValue + '%',
      scale: 1,
      duration: 0.5,
      ease: 'back.out(1.4)',
      overwrite: 'auto'
    }
  );
  const value = ring.querySelector('span');
  if (value !== null)
    gsap.fromTo(
      value,
      { autoAlpha: 0, y: 5 },
      { autoAlpha: 1, y: 0, duration: 0.28, ease: 'power2.out', overwrite: 'auto' }
    );
}

export function animateProgress(
  root: Element,
  fromValue: number,
  toValue: number,
  reducedMotion: boolean
): void {
  const progress = root.querySelector('.batch-progress span');
  if (progress === null) return;
  if (reducedMotion) return;
  gsap.fromTo(
    progress,
    { scaleX: fromValue },
    { scaleX: toValue, duration: 0.35, ease: 'power2.out', overwrite: 'auto' }
  );
}

export function animateMessage(root: Element, reducedMotion: boolean): void {
  if (reducedMotion) return;
  const notice = root.querySelector('.notice');
  if (notice !== null)
    gsap.from(notice, { autoAlpha: 0, y: 6, duration: 0.28, ease: 'power2.out' });
}

export function animateDropOverlay(root: Element, reducedMotion: boolean): void {
  if (reducedMotion) return;
  const overlay = root.querySelector('.drop-overlay');
  if (overlay === null) return;
  const icon = overlay.querySelector('span');
  gsap.from(overlay, { autoAlpha: 0, duration: 0.2, ease: 'power1.out' });
  if (icon !== null) gsap.from(icon, { scale: 0.84, y: 8, duration: 0.36, ease: 'back.out(1.5)' });
}

export function animateFileManager(root: Element, reducedMotion: boolean): void {
  if (reducedMotion) return;
  const backdrop = root.querySelector('.file-manager-backdrop');
  const dialog = root.querySelector('.file-manager');
  if (backdrop === null || dialog === null) return;
  gsap.from(backdrop, { autoAlpha: 0, duration: 0.2, ease: 'power1.out' });
  gsap.from(dialog, {
    autoAlpha: 0,
    y: 18,
    scale: 0.98,
    duration: 0.36,
    ease: 'power3.out',
    overwrite: 'auto'
  });
}

export function animateFileManagerRows(root: Element, reducedMotion: boolean): void {
  if (reducedMotion) return;
  const rows = root.querySelectorAll('.file-manager .file-list-row');
  if (rows.length > 0)
    gsap.from(rows, {
      autoAlpha: 0,
      y: 6,
      duration: 0.22,
      ease: 'power2.out',
      stagger: 0.03,
      overwrite: 'auto'
    });
}

export function animateTimelineTooltip(root: Element, reducedMotion: boolean): void {
  if (reducedMotion) return;
  const tooltip = root.querySelector('.timeline-tooltip');
  if (tooltip !== null)
    gsap.from(tooltip, { autoAlpha: 0, y: 5, duration: 0.2, ease: 'power2.out' });
}
