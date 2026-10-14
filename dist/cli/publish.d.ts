export interface PublishOptions {
    out: string;
    runs?: string[];
    runsDir?: string;
    dashboardDir?: string;
}
export declare class PublishError extends Error {
}
/** Build in memory first: rejected data never leaves a partial publish directory. */
export declare function publishSite(options: PublishOptions): {
    files: {
        path: string;
        bytes: number;
    }[];
    totalBytes: number;
};
