export interface ReinitPlan {
    version: 1;
    configPath: string;
    beforeConfig: string;
    afterConfig: string;
    beforeRecord: string | null;
    afterRecord: string | null;
}
export declare function reinitPath(configPath: string): string;
export declare function readReinit(configPath: string): ReinitPlan | null;
export declare function prepareReinit(configPath: string, afterConfig: string): ReinitPlan;
export declare function applyReinit(plan: ReinitPlan): void;
export declare function finishReinit(configPath: string): void;
