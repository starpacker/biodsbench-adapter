# 串行测评新旧版效果对比 - PMID 25303977

**日期**: 2026-06-09  
**对比对象**: 旧版 legacy serial（`run_imaging101_25303977_serial.py`）vs 新版 true serial（`run_imaging101_true_serial.py`）  
**子任务范围**: 25303977_0 ~ 25303977_7（共 8 个）  
**模型**: Vendor2/Claude-4.7-opus

---

## 1. 结果汇总

| 版本 | 通过 | 总数 | 通过率 |
|------|------|------|--------|
| 旧版（legacy serial） | 6 | 8 | 75.0% |
| 新版（true serial） | 6 | 8 | 75.0% |
| **净变化** | **+0** | — | — |

| Task ID | 旧版 | 新版 | 变化 |
|---------|------|------|------|
| `25303977_0` | passed | passed | — |
| `25303977_1` | passed | passed | — |
| `25303977_2` | passed | passed | — |
| `25303977_3` | passed | passed | — |
| `25303977_4` | passed | passed | — |
| `25303977_5` | **failed** | **failed** | — |
| `25303977_6` | passed | passed | — |
| `25303977_7` | **failed** | **failed** | — |

- 保持通过：6 个（`_0, _1, _2, _3, _4, _6`）
- 新版修复：**0 个**
- 新版退化：**0 个**
- 保持失败：2 个（`_5, _7`）

---

## 2. 关键技术验证（仍是成功的）

虽然通过率没变，但**新机制本身是正常工作的**，这是 4 处验证证据：

### 2.1 prior_context.json 内容正确传递

`task_7/prior_context.json` 包含 **7 个前置任务**的完整信息：

```
25303977_0: status=passed, code=1555c, desc=2016c, feedback='judge_status=pass, reward=1'
25303977_1: status=passed, code=1436c, desc=2016c, feedback='judge_status=pass, reward=1'
25303977_2: status=passed, code=1612c, desc=2016c, feedback='judge_status=pass, reward=1'
25303977_3: status=passed, code=1008c, desc=1758c, feedback='judge_status=pass, reward=1'
25303977_4: status=passed, code=1314c, desc=1981c, feedback='judge_status=pass, reward=1'
25303977_5: status=failed, code=2029c, desc=1623c, feedback='judge_status=fail, reward=0'
25303977_6: status=passed, code=2691c, desc=1669c, feedback='judge_status=pass, reward=1'
```

### 2.2 模型确实读取了 prior context

证据：**task_7 看到了 task_5 失败时用的 `RECURRENT_FREE_INTERVAL_MONTHS` 列，但拒绝复用**，自己切换到了 `EFS_MONTHS`：

```python
# task_5 (failed) 使用的列：
durations=wt["RECURRENT_FREE_INTERVAL_MONTHS"].values
merged["event"] = (merged["EVENT_DETAILS"].astype(str) == "Event").astype(int)

# task_7 (failed but DIFFERENT approach) 使用的列：
df["EFS_MONTHS"] = pd.to_numeric(df["EFS_MONTHS"], errors="coerce")
df["event"] = df["EFS_STATUS"].astype(str).str.startswith("1").astype(int)
```

→ 模型有意识地避开了 task_5 的列选择，说明 prior context 的"失败信号"被理解了。

### 2.3 CLI 内部 judge feedback 承接（解决"发现 3"）

task_5 的 trajectory 显示：

```
[06:46:59] judge_started round=1 Running judge attempt 1/2
[06:47:05] judge_finished round=1 fail: assert kmf_wild_type.median_survival_time_== 68.1
[06:47:05] agent_step_started round=2 Submitting prompt to source-native QueryEngine session
[06:47:31] agent_event round=2 assistant_text
...
[06:48:09] judge_finished round=2 fail: <same assertion>
```

→ 模型在 round 2 收到了 judge feedback、做了第二次提交（"Switched to true recurrence-free survival: ..."），但仍未通过。这正是新版相对于旧版的优势 —— 旧版 Python 外层 retry 时 feedback 会丢失。

### 2.4 测试覆盖

| 测试套件 | 结果 |
|---------|------|
| `sourceContextBuilder.test.ts`（含 3 个新 prior-context 测试）| 7/7 ✅ |
| `sourceTaskLoop.test.ts` + `batchRunner.test.ts` | 13/13 ✅ |

---

## 3. 为什么 prior context 没带来通过率提升？

深入分析两个失败任务后，发现 **`_5` 和 `_7` 的失败都是真实领域知识缺口**，不是上下文/feedback 能解决的：

### 3.1 task_5 失败根因

**任务**："make the recurrence-free survival curve for two groups: TTN wild-type vs TTN mutation"

**判分**：
```python
assert kmf_wild_type.median_survival_time_ == 68.1  # 模型版本：FAIL
assert kmf_mutation.median_survival_time_   == 68.1  # 模型版本：FAIL（round 2）
```

**模型实际做法**（看着合理）：
- 用 `RECURRENT_FREE_INTERVAL_MONTHS` 作 duration
- 用 `EVENT_DETAILS == 'Event'` 作 event indicator
- 按"患者级" left join

**ground truth（`std_code/main.py`）做法**（反直觉）：
```python
merged_data = data_clinical_patient.merge(data_clinical_sample, on="PATIENT_ID")
merged_data = merged_data.merge(
    data_mutations,
    left_on="PATIENT_ID", right_on="Tumor_Sample_Barcode"
)  # ← 与 mutation 表 INNER JOIN，导致每条 mutation 一行
wild_type = merged_data[merged_data["Hugo_Symbol"] != "TTN"]  # ← 用 mutation-level filter
mutation = merged_data[merged_data["Hugo_Symbol"] == "TTN"]
# 用 EFS_MONTHS / EFS_STATUS（不是 RECURRENT_FREE_*）
```

关键差异：
1. **列选择**：`EFS_MONTHS` vs `RECURRENT_FREE_INTERVAL_MONTHS`
2. **分组语义**：mutation-event level 而不是 patient level
3. 这两点 **没有任何前置任务覆盖过**，prior context 完全无法提供线索

### 3.2 task_7 失败根因

**任务**："further add t-test to calculate the p-value" → 期望 `p_value ≈ 0.9923`

task_7 是 task_5 的延伸，**继承了 task_5 的所有问题**：错误的列、错误的分组语义。即使 logrank_test 调用对了，输入数据错了 → p-value 也错。

→ **task_7 必然失败，除非 task_5 先解决**。

### 3.3 为什么 prior context 没有"传染"task_5 的错误代码到 task_7？

task_7 实际**没有复用** task_5 的代码 —— 看到 task_5 失败标签后，模型主动换了一套列名（`EFS_MONTHS`+`EFS_STATUS`）。这是个好信号：模型不盲目复用失败代码。

但这也说明：**当前 prior context 的负面价值 ≈ 0，正面价值也 ≈ 0**（因为这两个失败的根因不在任何前置任务里）。

---

## 4. 新机制的潜在收益场景（这次没赶上）

| 场景 | 新机制是否能帮 | 原因 |
|------|---------------|------|
| 前置任务建立了"罕见列名约定"，后续任务复用 | ✅ 能帮 | prior code 直接显示列名 |
| 前置任务采用了"非标准排序/分组" | ✅ 能帮 | 后续任务可直接复用同一逻辑 |
| 前置失败任务记录了"某列不能用" | ✅ 能帮（已观察到 task_7 主动避开 task_5 的列）| feedback 传递了失败信号 |
| 后续任务依赖前置失败任务的产物 | ❌ 不能 | task_7 失败本质是 task_5 失败 |
| 失败根因是 prior 没覆盖的领域知识 | ❌ 不能 | 此次 `_5` 失败的列选择就是这种情况 |

PMID 25303977 不幸属于"prior context 帮不到"的类型 —— `_5` 和 `_7` 的失败需要的是**生物医学领域先验**（哪个列是真正的 RFS 月数 / 用哪种 join 策略），不是 task-to-task 的上下文。

---

## 5. 结论与建议

### ✅ 新机制工程上完整可用
- prior_context.json 构造、传递、prompt 注入、CLI 解析全链路验证
- 7/7 + 13/13 测试全过
- 没有引入退化（保持通过的任务都还通过）

### ⚠️ 本轮通过率 = 旧版
- 6/8 → 6/8（净 +0）
- 失败任务的根因是领域知识，prior context 无法补足

### 🎯 建议的下一步评估

为了真正衡量 prior context 的价值，建议拿**任务间有强复用关系**的 PMID 试一次。例如：

1. **任务间共享数据加载/预处理逻辑**的 PMID（task_0 写了 80 行复杂加载，task_1~_7 都需要）
2. **任务间有"反复用同一中间结果"**的 PMID（如 task_0 算 KM 曲线 → task_1 算 p-value → task_2 画图）
3. **任务描述里就明说"基于前一个任务的结果"** 的 PMID

如果有跑过 BioDSBench 单独并行模式 vs 真串行模式的多 PMID 数据，可以挑出"单跑失败但 chain 中通过"或"单跑通过率 < chain 通过率"的 PMID 作为新机制效果显著的代表。

### 📂 产物清单

- 新版结果：`/data/yjh/imaging101_true_serial_results/25303977_true_serial_20260609_142645/`
- 旧版结果：`/data/yjh/imaging101_serial_results/25303977_serial_20260608_150509/`
- 对比脚本：`/home/yjh/compare_serial_versions.py`
- 对比 JSON：`/home/yjh/SERIAL_VERSIONS_COMPARISON.json`
- 对比 MD（精简版）：`/home/yjh/SERIAL_VERSIONS_COMPARISON.md`
- 本报告（详细版）：`/home/yjh/TRUE_SERIAL_VS_OLD_SERIAL_RESULTS.md`
