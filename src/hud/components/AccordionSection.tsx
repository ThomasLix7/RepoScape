import React, { useState } from 'react';

interface AccordionSectionProps {
  title: string;
  icon: string;
  isExpanded: boolean;
  onToggle: () => void;
  badge?: string | number;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}

export function AccordionSection({ title, icon, isExpanded, onToggle, badge, headerRight, children }: AccordionSectionProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div style={{ borderBottom: '1px solid #30363d' }}>
      <div
        onClick={onToggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          cursor: 'pointer',
          background: hovered ? '#21262d' : '#0d1117',
          transition: 'background 150ms',
          userSelect: 'none',
        }}
      >
        <span
          style={{
            display: 'inline-block',
            fontSize: 10,
            color: '#8b949e',
            transition: 'transform 0.2s ease-in-out',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            width: 12,
            textAlign: 'center',
          }}
        >
          ▶
        </span>
        <span style={{ fontSize: 12 }}>{icon}</span>
        <span style={{ color: '#f0f6fc', fontSize: 12, fontWeight: 600, flex: 1 }}>{title}</span>
        {headerRight !== undefined ? (
          headerRight
        ) : (
          badge !== undefined && badge !== '' && (
            <span
              style={{
                background: '#30363d',
                color: '#8b949e',
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 10,
                lineHeight: '16px',
              }}
            >
              {badge}
            </span>
          )
        )}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateRows: isExpanded ? '1fr' : '0fr',
          transition: 'grid-template-rows 200ms cubic-bezier(0.4, 0, 0.2, 1)',
          overflow: 'hidden',
        }}
      >
        <div style={{ minHeight: 0, minWidth: 0 }}>
          <div style={{ padding: '0 12px 12px' }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
