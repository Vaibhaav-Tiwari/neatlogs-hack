export const noopTrace = {
    async span(_name, _attributes, fn) {
        return fn({ set: () => { } });
    },
};
export function traceDecision(trace, name, attributes, fn) {
    return (trace ?? noopTrace).span(name, attributes, fn);
}
//# sourceMappingURL=trace.js.map