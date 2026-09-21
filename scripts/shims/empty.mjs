/**
 * An empty stand-in.
 *
 * Ink imports `react-devtools-core` at module load and only calls into it when
 * a development flag is set, which a released command never sets. Marking it
 * external left a real import that failed at startup; bundling it would put a
 * debugger inside the binary. Neither is what is wanted, so it resolves to
 * nothing.
 */
export default {};
export const connectToDevTools = () => {};
