export const mergeSuccess =
  /✓\s*Merged pull request|Merged pull request|Pull request successfully merged|Pull request\s+#?\d*\s+was\s+merged|结果=已合并|PR 已合并|已在 GitHub 合并成功|["']?merged["']?\s*[:=]\s*true|["']?state["']?\s*[:=]\s*["']?merged\b/i;
export const releaseCardText =
  /release decision card|发布决策卡|publish applicability|发布适用性|bump rule|version rule|版本提升规则|预测版本/i;
export const confirmCard =
  /(?<!不)(?:confirm|confirmed|approve|approved|accept|accepted|确认|同意|批准|可以|没问题|无异议|go ahead|proceed|卡片没问题).{0,120}(?:version expectation|predicted version|expected version|版本预期|预测版本|版本期望|版本按|不发布|不发版|no release|no version|\bv?\d+\.\d+)/i;
export const confirmNegated =
  /(?:\b(?:cannot|can't|unable to|do not|don't|without|not)\s+(?:confirm|approve|accept)\b|(?:不|未|无|不能|无法|尚未|待)\s*(?:确认|同意|批准))/i;
export const rerun =
  /(?:(?:gh(?:\s+(?:(?:-R|--repo)(?:=|\s+)\S+))?\s+run\s+rerun\s+(?:(?:(?:-R|--repo)(?:=|\s+)\S+)\s+)*([^\s;&|]+)|\/actions\/runs\/(\d+)\/rerun))/i;
export const routeMutation =
  /\bgh\s+pr\s+(?:create|edit|label)\b|\bcode_hosting(?:\.(?:py|ts))?\b[^\n]*\bpr-(?:create|edit)\b|\bgh\s+api\b(?=[^\n]*(?:\/pulls(?:\/\d+)?|\/issues\/\d+\/labels)(?:\s|$))(?=[^\n]*(?:\b(?:PATCH|POST|PUT)\b|--method(?:=|\s+)(?:PATCH|POST|PUT)\b|-X(?:=|\s+)(?:PATCH|POST|PUT)\b|(?:-f|-F|--raw-field|--field|--input)(?:=|\s+)))/i;
export const routeResolvedText =
  /pre[_ -]?merge[_ -]?release[_ -]?route|release[_ -]?route[_ -]?(?:re)?resolved|current[_ -]?release[_ -]?route|当前发布路由|发布路由已重新解析|current[_ -]?(?:repository|repo|PR)[_ -]?facts|当前(?:仓库|repository|PR)?事实/i;
export const dispositionProof =
  /release[_ -]?disposition[^\n]{0,120}(?:publication proof|proves publication|release_expected\s*[:=]\s*true|发布证明|证明发布)/i;
export const dispositionSeparation =
  /(?:not|does not|不|不能|不是)[^\n]{0,32}(?:publication proof|proves publication|release_expected|发布证明|证明发布)/i;
export const noExpectedEvidence =
  /(?:skipped|not[_ -]?expected|disabled|no release|未触发|不发布|未发现.{0,24}发布|仓库.{0,24}(?:发布面|发布合同)|repository.{0,24}release)/i;
export const rerunDisposition = /发布处置\s*[:=]\s*rerun-once/i;
export const failureSurface =
  /(?:失败面|failing[_ -]?surface)\s*[:=]\s*(?!none|unknown|未检查)[^\s，。；;,]+/i;
export const failureDisposition = /发布处置\s*[:=]\s*owner-action-required/i;
export const timeoutRecovery =
  /(?:下一门禁|流程锚点|恢复锚点)[^\n；。]*(?:release|发布)/i;
export const timeoutIncomplete = /post-merge[^\n；。]*(?:尚未完成|未完成)/i;
