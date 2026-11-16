import { describe, expect, test } from "bun:test";

import { videoRatioFormField } from "../src/lib/media-size";

/**
 * 回归守护（2026-11-16 seedance-2-5 事故）：ratio 表单字段必须始终产出
 * 标准枚举——比例缺省（auto/空）时归一为 16:9，绝不允许缺省发送；
 * 否则上游中转会用像素 size 约分生造比例（854x480 → "427:240"）被火山拒绝。
 */
describe("videoRatioFormField", () => {
    test("像素尺寸归约到最近的标准枚举", () => {
        expect(videoRatioFormField("854x480")).toBe("16:9");
        expect(videoRatioFormField("480x854")).toBe("9:16");
        expect(videoRatioFormField("480x480")).toBe("1:1");
        expect(videoRatioFormField("1280x720")).toBe("16:9");
    });

    test("auto/空值归一为 16:9（绝不允许缺省字段）", () => {
        expect(videoRatioFormField("auto")).toBe("16:9");
        expect(videoRatioFormField("")).toBe("16:9");
    });

    test("标准枚举原样透传", () => {
        expect(videoRatioFormField("16:9")).toBe("16:9");
        expect(videoRatioFormField("9:16")).toBe("9:16");
        expect(videoRatioFormField("1:1")).toBe("1:1");
        expect(videoRatioFormField("4:3")).toBe("4:3");
    });

    test("480p 各比例档位的 480p 尺寸串均归约出标准枚举", () => {
        for (const size of ["854x480", "480x854", "480x480", "640x480", "480x640"]) {
            const value = videoRatioFormField(size);
            expect(value).toMatch(/^(16:9|9:16|1:1|4:3|3:4|21:9|3:2|2:3)$/);
        }
    });
});
