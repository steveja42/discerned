// A sidebar section with a clickable header that expands/collapses its body.
// Used by the Discerns sidebar for every section (View, Following, Publishers,
// Signal, Qualifiers, Category). The body is conditionally rendered rather than
// height-animated — the sections are short and nothing here needs a measured height.

'use client';

import type React from 'react';

interface CollapsibleSectionProps {
  title: string;
  /** Right-aligned badge: a count for the list sections, the axis letter for the filter axes. */
  badge?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

export default function CollapsibleSection({ title, badge, open, onToggle, children }: CollapsibleSectionProps) {
  return (
    <div className="side-collapse">
      <button
        type="button"
        className="side-collapse-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <svg
          className="side-collapse-chev"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span className="side-collapse-title">{title}</span>
        {badge}
      </button>
      {open && children}
    </div>
  );
}
