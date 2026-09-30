// Virtual module supplied by EffectRuntime when it evaluates a checked template.
declare module '@motion' {
  export const Diagram: import('react').ComponentType<{
    plan?: import('../lib/motion-library/visual').VisualPlan;
    color?: string;
    accent?: string;
  }>;
}
