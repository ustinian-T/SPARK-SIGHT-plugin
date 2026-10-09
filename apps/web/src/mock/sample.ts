// 内置合成示例数据（非真实实验结果，仅用于走通闭环与界面演示）。
// 场景：三种处理（对照组 / 处理A / 处理B）在 6 个观测周的响应均值与标准差。
export const SAMPLE_FILE = 'nitrogen_response_demo.csv'

export const SAMPLE_CSV = `week,control,treatment_a,treatment_b,control_sd,treatment_a_sd,treatment_b_sd
1,12.0,12.3,12.1,0.5,0.6,0.5
2,13.4,14.6,14.0,0.7,0.9,0.8
3,14.8,17.5,16.2,0.8,1.2,1.0
4,16.1,20.4,18.6,0.9,1.4,1.1
5,17.2,23.1,20.9,1.0,1.5,1.2
6,18.0,25.6,22.8,1.1,1.6,1.3
`

export const SAMPLE_HINT = '合成示例数据：三处理组 × 6 个观测周，含均值与标准差（非真实实验结论）'
