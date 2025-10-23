'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, MessageCircle, Brain, Settings, BookOpen, Key, ChevronDown, ChevronUp, User, Plus, Edit2, Trash2, Check, X, List, Image, Upload, FileText } from 'lucide-react';

/**********************
 * Types
 **********************/
export interface Problem {
  id: string;
  title: string;
  content: string;
  imageUrl?: string;
  category?: string;
  grade?: string;
  unit?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  createdAt: string;
  updatedAt: string;
}

export interface DiagnosticData {
  diagnosis: {
    survey_gist: 'low' | 'medium' | 'high';
    question_focus: 'low' | 'medium' | 'high';
    reading_depth: 'low' | 'medium' | 'high';
    recite_articulation: 'low' | 'medium' | 'high';
    review_accuracy: 'low' | 'medium' | 'high';
    confidence_level: 'low' | 'medium' | 'high';
  };
  recommended_stage: 'survey' | 'question' | 'read' | 'recite' | 'review';
  stage_reason: string;
  next_question: string;
  feedback_completed: boolean;
}

export interface Message {
  id: string;
  type: 'student' | 'llm';
  content: string;
  timestamp: string;
  diagnostic?: DiagnosticData | null;
  rawResponse?: string;
  isError?: boolean;
  debug?: string;
  problemId?: string;
}

/**********************
 * Utilities
 **********************/
const nowTime = () =>
  new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Seoul',
  }).format(new Date());

const uid = () => Math.random().toString(36).slice(2);

const STAGES: Record<DiagnosticData['recommended_stage'], { color: string; label: string; subtitle: string }> = {
  survey: { color: 'bg-blue-100 text-blue-800', label: 'Survey', subtitle: '지문 훑어보기' },
  question: { color: 'bg-green-100 text-green-800', label: 'Question', subtitle: '문항 요구 파악' },
  read: { color: 'bg-orange-100 text-orange-800', label: 'Read', subtitle: '본문 정독 및 근거 찾기' },
  recite: { color: 'bg-purple-100 text-purple-800', label: 'Recite', subtitle: '핵심 내용 말해보기' },
  review: { color: 'bg-slate-100 text-slate-800', label: 'Review', subtitle: '선택지 검토 및 확인' },
};

function escapeNewlinesInsideStrings(src: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (!inString) {
      if (ch === '"') {
        inString = true;
        out += ch;
      } else {
        out += ch;
      }
      continue;
    }

    // inString === true
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === '\n') {
      out += '\\n';
      continue;
    }
    if (ch === '\r') {
      // CRLF → \n 로 통일
      if (src[i + 1] === '\n') {
        i++; // skip LF
      }
      out += '\\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** 모델이 내놓은 살짝 깨진 JSON도 최대한 복구해 파싱 */
function parseJsonLoose(text: string): unknown {
  const trim = (s: string) => s.trim();
  const tryParse = (src: string) => JSON.parse(trim(src));

  // 1) 먼저 줄바꿈 이스케이프 시도
  try { return tryParse(escapeNewlinesInsideStrings(text)); } catch {}

  // 2) 그대로
  try { return tryParse(text); } catch {}

  // 3) 펜스 제거
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/```\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) { 
    try { return tryParse(escapeNewlinesInsideStrings(fenced[1])); } catch {}
    try { return tryParse(fenced[1]); } catch {} 
  }

  // 4) 첫 { ~ 마지막 }
  const i = text.indexOf('{'); const j = text.lastIndexOf('}');
  if (i !== -1 && j !== -1 && j > i) {
    const candidate = text.slice(i, j + 1);
    // 4-1) 문자열 내부 개행 이스케이프 먼저 시도
    try { return tryParse(escapeNewlinesInsideStrings(candidate)); } catch {}
    // 4-2) 그대로도 시도
    try { return tryParse(candidate); } catch {}
  }

  // 5) 스마트따옴표 정규화
  const normalizedQuotes = text.replace(/[""]/g, '"').replace(/['']/g, "'");
  try { return tryParse(escapeNewlinesInsideStrings(normalizedQuotes)); } catch {}
  try { return tryParse(normalizedQuotes); } catch {}

  // 6) 트레일링 콤마 제거
  const noTrailingCommas = normalizedQuotes.replace(/,\s*([}\]])/g, '$1');
  try { return tryParse(escapeNewlinesInsideStrings(noTrailingCommas)); } catch {}
  try { return tryParse(noTrailingCommas); } catch {}

  // 7) 최후: 더 공격적인 정리
  const aggressive = noTrailingCommas
    .replace(/[\r\n]+/g, '\\n') // 모든 줄바꿈을 \n으로
    .replace(/\t/g, '\\t'); // 탭도 이스케이프
  return tryParse(aggressive); // 실패 시 여기서 throw
}

/**********************
 * Minimal runtime validation (no external deps)
 **********************/
function isEnum<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v);
}

function validateDiagnostic(obj: unknown): asserts obj is DiagnosticData {
  if (!obj || typeof obj !== 'object') throw new Error('진단 객체가 비어있습니다.');
  const o = obj as Record<string, unknown>;
  const d = o.diagnosis as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object') throw new Error('diagnosis 필드가 없습니다.');
  if (!isEnum(d.survey_gist, ['low', 'medium', 'high'] as const)) throw new Error('survey_gist 값 오류');
  if (!isEnum(d.question_focus, ['low', 'medium', 'high'] as const)) throw new Error('question_focus 값 오류');
  if (!isEnum(d.reading_depth, ['low', 'medium', 'high'] as const)) throw new Error('reading_depth 값 오류');
  if (!isEnum(d.recite_articulation, ['low', 'medium', 'high'] as const)) throw new Error('recite_articulation 값 오류');
  if (!isEnum(d.review_accuracy, ['low', 'medium', 'high'] as const)) throw new Error('review_accuracy 값 오류');
  if (!isEnum(d.confidence_level, ['low', 'medium', 'high'] as const)) throw new Error('confidence_level 값 오류');
  if (!isEnum(o.recommended_stage, ['survey', 'question', 'read', 'recite', 'review'] as const)) throw new Error('recommended_stage 값 오류');
  if (typeof o.stage_reason !== 'string') throw new Error('stage_reason은 문자열이어야 합니다.');
  if (typeof o.next_question !== 'string') throw new Error('next_question은 문자열이어야 합니다.');
  if (typeof o.feedback_completed !== 'boolean') throw new Error('feedback_completed는 boolean이어야 합니다.');
}

/**********************
 * Providers (Gemini only)
 **********************/
interface ProviderArgs {
  apiKey: string;
  systemPrompt: string;
  problem: string;
  problemImage?: string;
  userMessage: string;
  context: string;
  signal?: AbortSignal;
}

const SYSTEM_PROMPT_BASE = `당신은 영어와 국어 독해 시험을 준비하는 학습자를 돕는 교육용 LLM 코치입니다.
SQ3R 학습 전략(Survey → Question → Read → Recite → Review)을 바탕으로 학생의 지문 이해와 답안 준비 상태를 진단하세요.

### **입력 데이터**
- **지문/문제 정보**: {시험 지문, 발췌문, 혹은 문제 설명}
- **학생 응답**: {학생의 답변, 생각 정리, 또는 질문}
- **컨텍스트** (선택 사항): {이전 대화, 학습 선호, 반복되는 오류 패턴 등}

### **임무**
1. **SQ3R 단계별 진단** (각 항목은 low/medium/high 중 하나):
   - **survey_gist**: 학생이 지문의 구조와 주제를 얼마나 파악했는지 평가
   - **question_focus**: 학생이 문항의 요구사항과 채점 포인트를 명확히 이해했는지 판단
   - **reading_depth**: 지문에서 핵심 근거를 찾고 해석하는 능력 평가
   - **recite_articulation**: 내용을 요약·재진술하거나 자신의 말로 설명하는 능력 평가
   - **review_accuracy**: 선택지 확인, 답 검토 등 최종 점검을 수행하는 태도 평가
   - **confidence_level**: 학생 발화에서 드러나는 자신감 수준 (low/medium/high)

2. **SQ3R 추천 단계**:
   - 현재 상황에서 가장 시급하게 강화해야 할 단계 하나를 survey/question/read/recite/review 중 하나로 지정
   - 그 단계가 필요한 이유를 간단히 설명

3. **다음 액션 제안**:
   - 학생이 곧바로 실천할 수 있는 질문, 읽기 전략, 혹은 점검 과제를 제안

4. **피드백 완료 여부 판단**:
   - 학생이 목표 이해에 도달했거나 더 이상의 지도가 필요 없다고 판단되면 true, 아니라면 false

### **출력 형식**
{
  "diagnosis": {
    "survey_gist": "low/medium/high",
    "question_focus": "low/medium/high",
    "reading_depth": "low/medium/high",
    "recite_articulation": "low/medium/high",
    "review_accuracy": "low/medium/high",
    "confidence_level": "low/medium/high"
  },
  "recommended_stage": "survey/question/read/recite/review",
  "stage_reason": "추천 이유 설명",
  "next_question": "학생에게 줄 액션/질문",
  "feedback_completed": "true/false"
}`;

const SYSTEM_PROMPT_JSON_ONLY = `${SYSTEM_PROMPT_BASE}

---
반드시 위의 형식과 일치하는 **순수 JSON 객체 하나만** 출력하세요. 코드블록(\`\`\`), 마크다운, 주석, 추가 설명, 접두/접미 텍스트를 금지합니다.`;

const buildContext = (msgs: Message[]) =>
  msgs
    .slice(-10)  // 최근 10개 메시지
    .map((m) => {
      if (m.type === 'student') return `학생: ${m.content}`;
      if (m.type === 'llm' && !m.isError) return `선생님: ${m.content}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');

/**********************
 * Gemini minimal types
 **********************/
interface GeminiInlineData { data: string }
interface GeminiFunctionCall { name: string }
interface GeminiPart { text?: string; inlineData?: GeminiInlineData; functionCall?: GeminiFunctionCall }
interface GeminiCandidate { content?: { parts?: GeminiPart[] }; finishReason?: string }
interface GeminiResponse { promptFeedback?: { blockReason?: string }; candidates?: GeminiCandidate[] }

/**********************
 * Provider Call (Gemini)
 **********************/
async function callGemini({ apiKey, systemPrompt, problem, problemImage, userMessage, context, signal }: ProviderArgs): Promise<DiagnosticData> {
  const responseSchema = {
    type: "OBJECT",
    properties: {
      diagnosis: {
        type: "OBJECT",
        properties: {
          survey_gist:        { type: "STRING", enum: ["low","medium","high"] },
          question_focus:     { type: "STRING", enum: ["low","medium","high"] },
          reading_depth:      { type: "STRING", enum: ["low","medium","high"] },
          recite_articulation:{ type: "STRING", enum: ["low","medium","high"] },
          review_accuracy:    { type: "STRING", enum: ["low","medium","high"] },
          confidence_level:   { type: "STRING", enum: ["low","medium","high"] }
        },
        required: ["survey_gist","question_focus","reading_depth","recite_articulation","review_accuracy","confidence_level"]
      },
      recommended_stage: { type: "STRING", enum: ["survey","question","read","recite","review"] },
      stage_reason:      { type: "STRING" },
      next_question:     { type: "STRING" },
      feedback_completed: { type: "BOOLEAN" }
    },
    required: ["diagnosis","recommended_stage","stage_reason","next_question","feedback_completed"]
  } as const;

  // 이미지가 있는 경우와 없는 경우를 구분하여 처리
  const userParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  
  if (problemImage) {
    // 이미지가 있는 경우: 이미지와 텍스트를 함께 전송
    const base64Data = problemImage.split(',')[1]; // data:image/png;base64, 부분 제거
    userParts.push({
      inlineData: {
        mimeType: problemImage.split(':')[1].split(';')[0], // image/png, image/jpeg 등
        data: base64Data
      }
    });
    userParts.push({
      text:
        `### 실제 입력 데이터\n` +
        `- 문제: 위 이미지를 참고하세요. ${problem}\n` +
        `- 학생 응답: ${userMessage}\n` +
        `- 컨텍스트: ${context}`
    });
  } else {
    // 텍스트만 있는 경우
    userParts.push({
      text:
        `### 실제 입력 데이터\n` +
        `- 문제: ${problem}\n` +
        `- 학생 응답: ${userMessage}\n` +
        `- 컨텍스트: ${context}`
    });
  }

  const body = {
    systemInstruction: {
      role: "system",
      parts: [{ text: systemPrompt }]
    },
    contents: [
      {
        role: "user",
        parts: userParts
      }
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      responseSchema,
      thinkingConfig: {
        thinkingBudget: 1024
      }
    }
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify(body) }
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini API 오류: ${res.status} ${res.statusText} - ${t}`);
  }

  const data = (await res.json()) as GeminiResponse & {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string, inlineData?: { data: string } }> } }>;
  };

  const blocked = data?.promptFeedback?.blockReason;
  if (blocked) throw new Error(`안전성 정책으로 차단됨: ${blocked}`);

  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  let text = "";
  for (const p of parts) {
    if (typeof p?.text === "string" && p.text.trim()) { text = p.text.trim(); break; }
  }
  if (!text) {
    for (const p of parts) {
      const b64 = p?.inlineData?.data;
      if (b64) {
        try {
          const decoded = typeof globalThis.atob === "function" ? globalThis.atob(b64) : "";
          if (decoded.trim()) { text = decoded.trim(); break; }
        } catch {}
      }
    }
  }

  if (!text) {
    const finish = data?.candidates?.[0]?.finishReason;
    const hint = finish ? ` (finishReason: ${finish})` : "";
    throw new Error(`Gemini 응답에서 JSON 본문을 찾지 못했습니다.${hint}`);
  }

  const parsed = parseJsonLoose(text);
  validateDiagnostic(parsed);
  return parsed as DiagnosticData;
}

/**********************
 * Component
 **********************/
const MathTutorDiagnostic: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [problems, setProblems] = useState<Problem[]>([]);
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [currentDiagnostic, setCurrentDiagnostic] = useState<DiagnosticData | null>(null);
  const [showErrorDetail, setShowErrorDetail] = useState(false);
  const [showProblemManager, setShowProblemManager] = useState(false);
  const [isAddingProblem, setIsAddingProblem] = useState(false);
  const [editingProblemId, setEditingProblemId] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<'text' | 'image'>('text');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [newProblem, setNewProblem] = useState<Partial<Problem>>({
    title: '',
    content: '',
    category: '',
    grade: '',
    unit: '',
    difficulty: 'medium'
  });

  const abortRef = useRef<AbortController | null>(null);
  const SYSTEM_PROMPT_JSON = useMemo(() => SYSTEM_PROMPT_JSON_ONLY, []);

  const currentProblem = useMemo(() => {
    return problems.find(p => p.id === selectedProblemId);
  }, [problems, selectedProblemId]);

  // Load problems from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const storedProblems = localStorage.getItem('math_tutor_problems');
    if (storedProblems) {
      try {
        const parsed = JSON.parse(storedProblems) as Problem[];
        setProblems(parsed);
        if (parsed.length > 0 && !selectedProblemId) {
          setSelectedProblemId(parsed[0].id);
        }
      } catch (e) {
        console.error('Failed to load problems:', e);
        // Initialize with default problem
        const defaultProblem: Problem = {
          id: uid(),
          title: '과징금 제도 이해',
          content: `다음 글에 대한 이해로 적절하지 않은 것은?
과징금이란 법령, 자치 법규 등에 따른 의무를 위반한 자에 대해 그 위반 행위에 대한 제재로서 부과하는 금전적 제재를 말한다. 금전적 제재 수단이라는 점에서 과징금은 형벌로서의 금전적 제재인 벌금과 유사하지만, 사법 기관에서 부과하는 벌금과 달리 행정청에서 부과하는 행정적 제재라는 점에서 벌금과 구별된다. 과태료는 경미한 행정 법규 위반에 대해 부과하거나 경미한 형사 사범을 범죄자로 만들지 않기 위해 부과하는 반면, 과징금은 특정 법령을 위반하여 얻은 불법적 이익을 환수하기 위해 부과한다. 또한, 경미한 형사 사범에게 부과하는 과태료의 경우 행정청에서 우선 부과한 후에 최종적으로 사법 기관의 재판을 받는 과정을 거치며, 형벌을 대신하는 측면이 있으므로 과태료의 부과 대상을 형벌의 부과 대상으로 하지 않는 것을 원칙으로 한다. 하지만, 과징금은 목적과 성격이 형벌과 다르므로 동일한 위반 행위에 대해 형벌과 별도로 부과할 수 있으며, 위반 행위자가 행정 처분에 불복할 때에는 행정 소송을 제기할 수 있다.

현행법상에서 과징금 제도는 여러 가지 유형으로 규정되어 있지만, 큰 범주에서 그 유형을 경제적 이익 환수 과징금, 영업 정지 대체 과징금 등으로 나눌 수 있다. 경제적 이익 환수 과징금은 불법 행위로 얻어진 경제적 이익을 환수하기 위한 제도로, 위반 행위에 대한 제재로서의 성격과 부당 또는 불법적 이익을 환수하거나 박탈한다는 경제적인 성격을 함께 가지고 있다. 하지만 전자의 성격은 모든 제재 처분이 가진 공통점이므로 본래적인 특징은 후자의 성격에 있다고 볼 수 있으며, 이런 측면에서 이 유형을 '본래적 의미의 과징금'이라고 한다. 이유형의 과징금은 불법적 이익의 환수를 목적으로 한 기존의 몰수 ‧ 추징 제도가 복잡한 형사 절차로 인해 집행 과정에 어려움이 많다는 점을 고려하여, 환수 절차의 효율성을 높이기 위해 도입되었다.

영업 정지 처분은 영업의 전부 또는 일부를 정지하는 행정처분이다. 행정청은 영업 허가 등의 수익적 행정 행위를 집행한 후, 영업 정지라는 강력한 제재 수단을 통해 행정상의 의무를 위반한 영업자를 관리하고 제재할 수 있다. 하지만 영업 정지로 인해 공공의 편익이 감소할 수가 있어 의료, 복지 분야 등 공공의 편익에 중대한 영향을 미치는 영업에 한해 공익적 관점에서 영업을 계속하게 하고, 의무 위반에 따른 영업 정지처분에 갈음하는 영업 정지 대체 과징금이 도입되었다. 이 유형의 과징금은 본래적 의미의 과징금의 성격도 띠고 있지만, 영업 정지 처분을 갈음하여 과징금을 부과한다는 점에서 '변형된 과징금'이라고 한다. 이 유형에서는 행정 집행 과정에서 행정 처분이 결정되기 전에 위반 행위자가 의견을 제출할 수는 있지만 처분을 선택할 수 없고, 공익성 판정에 대한 민원 등 처분의 결정에 불복하는 경우가 많아 행정 집행 과정에서 어려움이 발생할 수 있다. 이 때문에 실제 행정 집행의 효율성을 고려해 위반 행위자에게 처분의 명시적인 선택권을 부여해야 한다는 주장과 공익적 성격이 적은 영업이 처분받은 영업 정지에 대해서도 과징금을 도입해야 한다는 주장이 현행 제도를 보완하기 위한 의견으로 제시되고 있다.

과징금은 국민의 이익을 침해하는 침익적 행정 행위이므로 법률 유보의 원칙을 따른다. 법률 유보의 원칙이란 행정 작용이 행해짐에 있어서 법적 근거가 요구된다는 것이다. 따라서 과징금의 근거가 되는 개별 법률에서는 부과 및 징수의 주체, 부과 사유, 상한액, 납부 기한 연기, 분할 납부 등에 관한 사항을 명확히 규정함으로써 침익적 행정 행위의 남용을 방지하고 있다. 과징금은 일괄 납부하는 것을 원칙으로 하지만, 일괄 납부 시 자금 사정에 현저한 어려움이 예상되는 경우 등에 한해 납부 기한 연기나 분할 납부를 허용한다. 과징금 납부 의무자가 기한 연기나 분할 납부를 하려 할 때에는 납부 기한 10일 전까지 문서를 통해 행정청에 신청해야 한다. 과징금 제도는 이러한 법률 유보의 원칙을 통해 행정 집행 과정에서 국민의 권익이 과도하게 침해되는 것을 방지하고 있다.

①변형된 과징금은 행정청의 수익적 행정 행위에 대한 사후 관리 수단으로 볼 수 있다.
②본래적 의미의 과징금과 변형된 과징금은 모두 위반 행위에 대한 제재로서의 성격을 지닌다.
③본래적 의미의 과징금은 기존 몰수 ‧ 추징 제도가 지닌 집행 과정의 어려움을 고려하여 도입되었다.
④본래적 의미의 과징금과 달리 변형된 과징금에 대해서는 위반 행위자가 행정 처분에 불복할 때 행정 소송을 제기할 수 있다.
⑤본래적 의미의 과징금과 변형된 과징금은 모두, 침익적 행정 행위의 남용을 방지하기 위해 명확한 법적 근거에 따라 부과된다.`,
          category: '국어 독해',
          difficulty: 'medium',
          createdAt: nowTime(),
          updatedAt: nowTime()
        };
        setProblems([defaultProblem]);
        setSelectedProblemId(defaultProblem.id);
      }
    } else {
      // Initialize with default problem if no stored problems
      const defaultProblem: Problem = {
        id: uid(),
        title: '과징금 제도 이해',
        content: `다음 글에 대한 이해로 적절하지 않은 것은?
과징금이란 법령, 자치 법규 등에 따른 의무를 위반한 자에 대해 그 위반 행위에 대한 제재로서 부과하는 금전적 제재를 말한다. 금전적 제재 수단이라는 점에서 과징금은 형벌로서의 금전적 제재인 벌금과 유사하지만, 사법 기관에서 부과하는 벌금과 달리 행정청에서 부과하는 행정적 제재라는 점에서 벌금과 구별된다. 과태료는 경미한 행정 법규 위반에 대해 부과하거나 경미한 형사 사범을 범죄자로 만들지 않기 위해 부과하는 반면, 과징금은 특정 법령을 위반하여 얻은 불법적 이익을 환수하기 위해 부과한다. 또한, 경미한 형사 사범에게 부과하는 과태료의 경우 행정청에서 우선 부과한 후에 최종적으로 사법 기관의 재판을 받는 과정을 거치며, 형벌을 대신하는 측면이 있으므로 과태료의 부과 대상을 형벌의 부과 대상으로 하지 않는 것을 원칙으로 한다. 하지만, 과징금은 목적과 성격이 형벌과 다르므로 동일한 위반 행위에 대해 형벌과 별도로 부과할 수 있으며, 위반 행위자가 행정 처분에 불복할 때에는 행정 소송을 제기할 수 있다.

현행법상에서 과징금 제도는 여러 가지 유형으로 규정되어 있지만, 큰 범주에서 그 유형을 경제적 이익 환수 과징금, 영업 정지 대체 과징금 등으로 나눌 수 있다. 경제적 이익 환수 과징금은 불법 행위로 얻어진 경제적 이익을 환수하기 위한 제도로, 위반 행위에 대한 제재로서의 성격과 부당 또는 불법적 이익을 환수하거나 박탈한다는 경제적인 성격을 함께 가지고 있다. 하지만 전자의 성격은 모든 제재 처분이 가진 공통점이므로 본래적인 특징은 후자의 성격에 있다고 볼 수 있으며, 이런 측면에서 이 유형을 '본래적 의미의 과징금'이라고 한다. 이유형의 과징금은 불법적 이익의 환수를 목적으로 한 기존의 몰수 ‧ 추징 제도가 복잡한 형사 절차로 인해 집행 과정에 어려움이 많다는 점을 고려하여, 환수 절차의 효율성을 높이기 위해 도입되었다.

영업 정지 처분은 영업의 전부 또는 일부를 정지하는 행정처분이다. 행정청은 영업 허가 등의 수익적 행정 행위를 집행한 후, 영업 정지라는 강력한 제재 수단을 통해 행정상의 의무를 위반한 영업자를 관리하고 제재할 수 있다. 하지만 영업 정지로 인해 공공의 편익이 감소할 수가 있어 의료, 복지 분야 등 공공의 편익에 중대한 영향을 미치는 영업에 한해 공익적 관점에서 영업을 계속하게 하고, 의무 위반에 따른 영업 정지처분에 갈음하는 영업 정지 대체 과징금이 도입되었다. 이 유형의 과징금은 본래적 의미의 과징금의 성격도 띠고 있지만, 영업 정지 처분을 갈음하여 과징금을 부과한다는 점에서 '변형된 과징금'이라고 한다. 이 유형에서는 행정 집행 과정에서 행정 처분이 결정되기 전에 위반 행위자가 의견을 제출할 수는 있지만 처분을 선택할 수 없고, 공익성 판정에 대한 민원 등 처분의 결정에 불복하는 경우가 많아 행정 집행 과정에서 어려움이 발생할 수 있다. 이 때문에 실제 행정 집행의 효율성을 고려해 위반 행위자에게 처분의 명시적인 선택권을 부여해야 한다는 주장과 공익적 성격이 적은 영업이 처분받은 영업 정지에 대해서도 과징금을 도입해야 한다는 주장이 현행 제도를 보완하기 위한 의견으로 제시되고 있다.

과징금은 국민의 이익을 침해하는 침익적 행정 행위이므로 법률 유보의 원칙을 따른다. 법률 유보의 원칙이란 행정 작용이 행해짐에 있어서 법적 근거가 요구된다는 것이다. 따라서 과징금의 근거가 되는 개별 법률에서는 부과 및 징수의 주체, 부과 사유, 상한액, 납부 기한 연기, 분할 납부 등에 관한 사항을 명확히 규정함으로써 침익적 행정 행위의 남용을 방지하고 있다. 과징금은 일괄 납부하는 것을 원칙으로 하지만, 일괄 납부 시 자금 사정에 현저한 어려움이 예상되는 경우 등에 한해 납부 기한 연기나 분할 납부를 허용한다. 과징금 납부 의무자가 기한 연기나 분할 납부를 하려 할 때에는 납부 기한 10일 전까지 문서를 통해 행정청에 신청해야 한다. 과징금 제도는 이러한 법률 유보의 원칙을 통해 행정 집행 과정에서 국민의 권익이 과도하게 침해되는 것을 방지하고 있다.

①변형된 과징금은 행정청의 수익적 행정 행위에 대한 사후 관리 수단으로 볼 수 있다.
②본래적 의미의 과징금과 변형된 과징금은 모두 위반 행위에 대한 제재로서의 성격을 지닌다.
③본래적 의미의 과징금은 기존 몰수 ‧ 추징 제도가 지닌 집행 과정의 어려움을 고려하여 도입되었다.
④본래적 의미의 과징금과 달리 변형된 과징금에 대해서는 위반 행위자가 행정 처분에 불복할 때 행정 소송을 제기할 수 있다.
⑤본래적 의미의 과징금과 변형된 과징금은 모두, 침익적 행정 행위의 남용을 방지하기 위해 명확한 법적 근거에 따라 부과된다.`,
        category: '국어 독해',
        difficulty: 'medium',
        createdAt: nowTime(),
        updatedAt: nowTime()
      };
      setProblems([defaultProblem]);
      setSelectedProblemId(defaultProblem.id);
    }
  }, []);

  // Save problems to localStorage whenever they change
  useEffect(() => {
    if (typeof window === 'undefined' || problems.length === 0) return;
    localStorage.setItem('math_tutor_problems', JSON.stringify(problems));
  }, [problems]);


  // 환경변수에서 API 키 로드
  useEffect(() => {
    // 먼저 환경변수 직접 확인
    const envApiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (envApiKey) {
      setApiKey(envApiKey);
    } else {
      // API 엔드포인트에서 가져오기
      fetch('/api/config')
        .then(res => res.json())
        .then(data => {
          if (data.apiKey) {
            setApiKey(data.apiKey);
          }
        })
        .catch(err => console.error('Failed to load API key:', err));
    }
  }, []);

  const clearChat = () => {
    setMessages([]);
    setCurrentDiagnostic(null);
  };

  const addProblem = () => {
    if (!newProblem.title?.trim()) {
      alert('문제 제목을 입력해주세요.');
      return;
    }
    
    if (!newProblem.content?.trim() && !newProblem.imageUrl) {
      alert('문제 내용이나 이미지를 입력해주세요.');
      return;
    }

    const problem: Problem = {
      id: uid(),
      title: newProblem.title.trim(),
      content: newProblem.content?.trim() || '',
      imageUrl: newProblem.imageUrl,
      category: newProblem.category?.trim() || '',
      grade: newProblem.grade?.trim() || '',
      unit: newProblem.unit?.trim() || '',
      difficulty: newProblem.difficulty || 'medium',
      createdAt: nowTime(),
      updatedAt: nowTime()
    };

    setProblems(prev => [...prev, problem]);
    setSelectedProblemId(problem.id);
    setNewProblem({
      title: '',
      content: '',
      imageUrl: undefined,
      category: '',
      grade: '',
      unit: '',
      difficulty: 'medium'
    });
    setIsAddingProblem(false);
    setInputMode('text');
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const updateProblem = (problemId: string) => {
    if (!newProblem.title?.trim()) {
      alert('문제 제목을 입력해주세요.');
      return;
    }
    
    if (!newProblem.content?.trim() && !newProblem.imageUrl) {
      alert('문제 내용이나 이미지를 입력해주세요.');
      return;
    }

    setProblems(prev => prev.map(p => 
      p.id === problemId 
        ? {
            ...p,
            title: newProblem.title!.trim(),
            content: newProblem.content?.trim() || '',
            imageUrl: newProblem.imageUrl,
            category: newProblem.category?.trim() || '',
            grade: newProblem.grade?.trim() || '',
            unit: newProblem.unit?.trim() || '',
            difficulty: newProblem.difficulty || 'medium',
            updatedAt: nowTime()
          }
        : p
    ));
    
    setEditingProblemId(null);
    setNewProblem({
      title: '',
      content: '',
      imageUrl: undefined,
      category: '',
      grade: '',
      unit: '',
      difficulty: 'medium'
    });
    setInputMode('text');
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const deleteProblem = (problemId: string) => {
    if (problems.length <= 1) {
      alert('최소 1개의 문제는 있어야 합니다.');
      return;
    }

    if (confirm('이 문제를 삭제하시겠습니까?')) {
      setProblems(prev => prev.filter(p => p.id !== problemId));
      if (selectedProblemId === problemId) {
        const remainingProblems = problems.filter(p => p.id !== problemId);
        if (remainingProblems.length > 0) {
          setSelectedProblemId(remainingProblems[0].id);
        }
      }
    }
  };

  const startEditProblem = (problem: Problem) => {
    setEditingProblemId(problem.id);
    setNewProblem({
      title: problem.title,
      content: problem.content,
      imageUrl: problem.imageUrl,
      category: problem.category,
      grade: problem.grade,
      unit: problem.unit,
      difficulty: problem.difficulty
    });
    if (problem.imageUrl) {
      setInputMode('image');
      setImagePreview(problem.imageUrl);
    } else {
      setInputMode('text');
    }
  };

  const cancelEdit = () => {
    setEditingProblemId(null);
    setIsAddingProblem(false);
    setNewProblem({
      title: '',
      content: '',
      imageUrl: undefined,
      category: '',
      grade: '',
      unit: '',
      difficulty: 'medium'
    });
    setInputMode('text');
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const contextText = useMemo(() => buildContext(messages), [messages]);

  const sendToGemini = useCallback(async (userMessage: string) => {
    if (!currentProblem) {
      throw new Error('문제가 선택되지 않았습니다.');
    }
    const args: ProviderArgs = {
      apiKey,
      systemPrompt: SYSTEM_PROMPT_JSON,
      problem: currentProblem.content || '이미지 문제',
      problemImage: currentProblem.imageUrl,
      userMessage,
      context: contextText,
      signal: abortRef.current?.signal,
    };
    return callGemini(args);
  }, [apiKey, SYSTEM_PROMPT_JSON, currentProblem, contextText]);

  const handleSendMessage = async () => {
    if (!currentInput.trim()) return;
    if (!apiKey) {
      alert('API 키를 먼저 입력해주세요.');
      return;
    }

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setIsLoading(true);
    const studentMessage: Message = {
      id: uid(),
      type: 'student',
      content: currentInput,
      timestamp: nowTime(),
    };
    setMessages((prev) => [...prev, studentMessage]);

    try {
      const diagnostic = await sendToGemini(currentInput);
      setCurrentDiagnostic(diagnostic);
      const llmMessage: Message = {
        id: uid(),
        type: 'llm',
        content: diagnostic.next_question, // 권장 다음 질문을 응답으로 표시
        diagnostic,
        timestamp: nowTime(),
      };
      setMessages((prev) => [...prev, llmMessage]);
      setCurrentInput('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '알 수 없는 오류';
      const llmMessage: Message = {
        id: uid(),
        type: 'llm',
        content: `오류가 발생했습니다: ${msg}`,
        timestamp: nowTime(),
        isError: true,
        debug: err instanceof Error ? String(err.stack ?? '') : undefined,
      };
      setMessages((prev) => [...prev, llmMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  };

const stagePill = (stage?: DiagnosticData['recommended_stage']) => {
  if (!stage) return null;
  const meta = STAGES[stage];
  if (!meta) {
    return (
      <span className="px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-800">
        SQ3R 단계 미정
      </span>
    );
  }
  return (
    <span className={`px-3 py-1 rounded-full text-sm font-medium ${meta.color}`}>
      SQ3R · {meta.label} ({meta.subtitle})
    </span>
  );
};

  return (
    <div className="w-full min-h-screen bg-gray-50 py-4 sm:py-6 lg:py-8">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-4 sm:mb-6">
          <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-gray-900 mb-2 flex items-center gap-1 sm:gap-2">
            <Brain className="text-blue-600" />
            독해 교육용 LLM 진단 시스템 (Gemini 전용)
          </h1>
          <p className="text-gray-600 text-xs sm:text-sm">학생-LLM 대화형 진단 시스템</p>
        </div>

      {/* API 키가 환경변수로 설정되어 있으므로 UI에서 제거 */}

      <div className="bg-white rounded-lg shadow-sm border p-4 sm:p-5 mb-4 sm:mb-6">
        <div className="flex justify-between items-start mb-3">
          <h2 className="text-base sm:text-lg font-semibold text-gray-900 flex items-center gap-1 sm:gap-2">
            <BookOpen className="text-green-600" size={20} />
            문제 관리
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => setShowProblemManager(!showProblemManager)}
              className="px-2 sm:px-3 py-1 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 flex items-center gap-1 text-xs sm:text-sm"
            >
              <List size={16} />
              {showProblemManager ? '닫기' : '문제 목록'} ({problems.length})
            </button>
            <button
              onClick={() => setIsAddingProblem(true)}
              className="px-2 sm:px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1 text-xs sm:text-sm"
            >
              <Plus size={16} />
              새 문제
            </button>
          </div>
        </div>

        {/* Current Problem Display */}
        {currentProblem && !showProblemManager && (
          <div className="bg-blue-50 p-4 sm:p-5 rounded-lg">
            <div className="flex justify-between items-start mb-2">
              <h3 className="font-semibold text-gray-900 text-sm sm:text-base">{currentProblem.title}</h3>
              <div className="flex gap-2 flex-wrap">
                {currentProblem.grade && (
                  <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs font-medium">
                    {currentProblem.grade}
                  </span>
                )}
                {currentProblem.unit && (
                  <span className="px-2 py-1 bg-indigo-100 text-indigo-800 rounded text-xs font-medium">
                    {currentProblem.unit}
                  </span>
                )}
                {currentProblem.difficulty && (
                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                    currentProblem.difficulty === 'easy' ? 'bg-green-100 text-green-800' :
                    currentProblem.difficulty === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                    'bg-red-100 text-red-800'
                  }`}>
                    {currentProblem.difficulty === 'easy' ? '쉬움' :
                     currentProblem.difficulty === 'medium' ? '보통' : '어려움'}
                  </span>
                )}
                {currentProblem.category && (
                  <span className="px-2 py-1 bg-purple-100 text-purple-800 rounded text-xs font-medium">
                    {currentProblem.category}
                  </span>
                )}
              </div>
            </div>
            {currentProblem.imageUrl ? (
              <div>
                <img 
                  src={currentProblem.imageUrl} 
                  alt="문제 이미지" 
                  className="w-full max-h-64 object-contain border border-gray-200 rounded p-2"
                />
                {currentProblem.content && (
                  <p className="text-gray-600 text-xs sm:text-sm mt-2">{currentProblem.content}</p>
                )}
              </div>
            ) : (
              <p className="text-gray-800 whitespace-pre-wrap text-xs sm:text-sm">{currentProblem.content}</p>
            )}
          </div>
        )}

        {/* Problem List */}
        {showProblemManager && (
          <div className="space-y-2 mt-3 sm:mt-4">
            {problems.map((problem) => (
              <div
                key={problem.id}
                className={`border rounded-lg p-2 sm:p-3 ${
                  selectedProblemId === problem.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
                } ${editingProblemId === problem.id ? 'bg-yellow-50' : ''}`}
              >
                {editingProblemId === problem.id ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={newProblem.title}
                      onChange={(e) => setNewProblem(prev => ({ ...prev, title: e.target.value }))}
                      placeholder="문제 제목"
                      className="w-full px-2 sm:px-3 py-1 border border-gray-300 rounded text-sm text-gray-900"
                    />
                    
                    {/* 입력 방식 선택 탭 */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setInputMode('text')}
                        className={`flex-1 px-2 py-1 rounded flex items-center justify-center gap-1 text-xs transition-colors ${
                          inputMode === 'text' 
                            ? 'bg-blue-500 text-white' 
                            : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                        }`}
                      >
                        <FileText size={14} />
                        텍스트
                      </button>
                      <button
                        onClick={() => setInputMode('image')}
                        className={`flex-1 px-2 py-1 rounded flex items-center justify-center gap-1 text-xs transition-colors ${
                          inputMode === 'image' 
                            ? 'bg-blue-500 text-white' 
                            : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                        }`}
                      >
                        <Image size={14} />
                        이미지
                      </button>
                    </div>
                    
                    {inputMode === 'text' ? (
                      <textarea
                        value={newProblem.content}
                        onChange={(e) => setNewProblem(prev => ({ ...prev, content: e.target.value }))}
                        placeholder="문제 내용"
                        className="w-full px-2 sm:px-3 py-1 sm:py-2 border border-gray-300 rounded text-sm text-gray-900"
                        rows={3}
                      />
                    ) : (
                      <div className="space-y-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              setImageFile(file);
                              const reader = new FileReader();
                              reader.onloadend = () => {
                                setImagePreview(reader.result as string);
                                setNewProblem(prev => ({ 
                                  ...prev, 
                                  imageUrl: reader.result as string,
                                  content: `[이미지 문제: ${file.name}]`
                                }));
                              };
                              reader.readAsDataURL(file);
                            }
                          }}
                          className="hidden"
                        />
                        
                        {!imagePreview ? (
                          <button
                            onClick={() => fileInputRef.current?.click()}
                            className="w-full h-24 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center gap-1 hover:border-gray-400 hover:bg-gray-50 transition-colors cursor-pointer"
                          >
                            <Upload size={20} className="text-gray-400" />
                            <span className="text-xs text-gray-600">이미지 선택</span>
                          </button>
                        ) : (
                          <div className="relative">
                            <img 
                              src={imagePreview} 
                              alt="문제 이미지" 
                              className="w-full max-h-32 object-contain border border-gray-300 rounded"
                            />
                            <button
                              onClick={() => {
                                setImageFile(null);
                                setImagePreview(null);
                                setNewProblem(prev => ({ 
                                  ...prev, 
                                  imageUrl: undefined,
                                  content: ''
                                }));
                                if (fileInputRef.current) {
                                  fileInputRef.current.value = '';
                                }
                              }}
                              className="absolute top-1 right-1 p-0.5 bg-red-500 text-white rounded-full hover:bg-red-600"
                              title="이미지 제거"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newProblem.grade}
                        onChange={(e) => setNewProblem(prev => ({ ...prev, grade: e.target.value }))}
                        placeholder="학년 (예: 중1, 고2)"
                        className="w-24 px-2 sm:px-3 py-1 border border-gray-300 rounded text-sm text-gray-900"
                      />
                      <input
                        type="text"
                        value={newProblem.unit}
                        onChange={(e) => setNewProblem(prev => ({ ...prev, unit: e.target.value }))}
                        placeholder="단원명"
                        className="flex-1 px-2 sm:px-3 py-1 border border-gray-300 rounded text-sm text-gray-900"
                      />
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newProblem.category}
                        onChange={(e) => setNewProblem(prev => ({ ...prev, category: e.target.value }))}
                        placeholder="카테고리 (선택)"
                        className="flex-1 px-2 sm:px-3 py-1 border border-gray-300 rounded text-sm text-gray-900"
                      />
                      <select
                        value={newProblem.difficulty}
                        onChange={(e) => setNewProblem(prev => ({ ...prev, difficulty: e.target.value as 'easy' | 'medium' | 'hard' }))}
                        className="px-2 sm:px-3 py-1 border border-gray-300 rounded text-sm text-gray-900"
                      >
                        <option value="easy">쉬움</option>
                        <option value="medium">보통</option>
                        <option value="hard">어려움</option>
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => updateProblem(problem.id)}
                        className="px-2 sm:px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1 text-sm"
                      >
                        <Check size={16} />
                        저장
                      </button>
                      <button
                        onClick={cancelEdit}
                        className="px-2 sm:px-3 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 flex items-center gap-1 text-sm"
                      >
                        <X size={16} />
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <h4 className="font-semibold text-gray-900 text-sm sm:text-base">{problem.title}</h4>
                        {problem.imageUrl ? (
                          <div className="mt-1">
                            <img 
                              src={problem.imageUrl} 
                              alt="문제 이미지" 
                              className="w-full max-h-24 object-contain border border-gray-200 rounded p-1"
                            />
                            {problem.content && (
                              <p className="text-gray-500 text-xs mt-1">{problem.content}</p>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs sm:text-sm text-gray-600 mt-1 line-clamp-2">{problem.content}</p>
                        )}
                        <div className="flex gap-2 mt-2 flex-wrap">
                          {problem.grade && (
                            <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs font-medium">
                              {problem.grade}
                            </span>
                          )}
                          {problem.unit && (
                            <span className="px-2 py-0.5 bg-indigo-100 text-indigo-800 rounded text-xs font-medium">
                              {problem.unit}
                            </span>
                          )}
                          {problem.difficulty && (
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                              problem.difficulty === 'easy' ? 'bg-green-100 text-green-800' :
                              problem.difficulty === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                              'bg-red-100 text-red-800'
                            }`}>
                              {problem.difficulty === 'easy' ? '쉬움' :
                               problem.difficulty === 'medium' ? '보통' : '어려움'}
                            </span>
                          )}
                          {problem.category && (
                            <span className="px-2 py-0.5 bg-purple-100 text-purple-800 rounded text-xs font-medium">
                              {problem.category}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-1 ml-2">
                        <button
                          onClick={() => setSelectedProblemId(problem.id)}
                          className={`p-1 rounded ${
                            selectedProblemId === problem.id 
                              ? 'bg-blue-600 text-white' 
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                          title="선택"
                        >
                          <Check size={16} />
                        </button>
                        <button
                          onClick={() => startEditProblem(problem)}
                          className="p-1 bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
                          title="편집"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button
                          onClick={() => deleteProblem(problem.id)}
                          className="p-1 bg-gray-100 text-red-600 rounded hover:bg-red-100"
                          title="삭제"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add New Problem Form */}
        {isAddingProblem && (
          <div className="mt-4 border-2 border-green-300 rounded-lg p-4 sm:p-5 bg-green-50">
            <h3 className="font-semibold text-gray-900 mb-2 sm:mb-3 text-sm sm:text-base">새 문제 추가</h3>
            <div className="space-y-2">
              <input
                type="text"
                value={newProblem.title}
                onChange={(e) => setNewProblem(prev => ({ ...prev, title: e.target.value }))}
                placeholder="문제 제목"
                className="w-full px-3 py-2 border border-gray-300 rounded text-gray-900"
              />
              
              {/* 입력 방식 선택 탭 */}
              <div className="flex gap-2 mb-2">
                <button
                  onClick={() => setInputMode('text')}
                  className={`flex-1 px-3 py-2 rounded flex items-center justify-center gap-2 transition-colors ${
                    inputMode === 'text' 
                      ? 'bg-blue-500 text-white' 
                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  <FileText size={18} />
                  텍스트 입력
                </button>
                <button
                  onClick={() => setInputMode('image')}
                  className={`flex-1 px-3 py-2 rounded flex items-center justify-center gap-2 transition-colors ${
                    inputMode === 'image' 
                      ? 'bg-blue-500 text-white' 
                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  <Image size={18} />
                  이미지 업로드
                </button>
              </div>
              
              {/* 텍스트 입력 영역 */}
              {inputMode === 'text' ? (
                <textarea
                  value={newProblem.content}
                  onChange={(e) => setNewProblem(prev => ({ ...prev, content: e.target.value }))}
                  placeholder="문제 내용을 입력하세요"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-gray-900"
                  rows={4}
                />
              ) : (
                /* 이미지 업로드 영역 */
                <div className="space-y-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setImageFile(file);
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          setImagePreview(reader.result as string);
                          setNewProblem(prev => ({ 
                            ...prev, 
                            imageUrl: reader.result as string,
                            content: `[이미지 문제: ${file.name}]`
                          }));
                        };
                        reader.readAsDataURL(file);
                      }
                    }}
                    className="hidden"
                  />
                  
                  {!imagePreview ? (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full h-32 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center gap-2 hover:border-gray-400 hover:bg-gray-50 transition-colors cursor-pointer"
                    >
                      <Upload size={32} className="text-gray-400" />
                      <span className="text-sm text-gray-600">클릭하여 이미지를 선택하세요</span>
                      <span className="text-xs text-gray-500">JPG, PNG, GIF 등 지원</span>
                    </button>
                  ) : (
                    <div className="relative">
                      <img 
                        src={imagePreview} 
                        alt="문제 이미지 미리보기" 
                        className="w-full max-h-64 object-contain border border-gray-300 rounded"
                      />
                      <button
                        onClick={() => {
                          setImageFile(null);
                          setImagePreview(null);
                          setNewProblem(prev => ({ 
                            ...prev, 
                            imageUrl: undefined,
                            content: ''
                          }));
                          if (fileInputRef.current) {
                            fileInputRef.current.value = '';
                          }
                        }}
                        className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600"
                        title="이미지 제거"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )}
                  
                  {imageFile && (
                    <div className="text-xs text-gray-600">
                      파일명: {imageFile.name} ({(imageFile.size / 1024).toFixed(2)} KB)
                    </div>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newProblem.grade}
                  onChange={(e) => setNewProblem(prev => ({ ...prev, grade: e.target.value }))}
                  placeholder="학년 (예: 중1, 고2)"
                  className="w-28 px-2 sm:px-3 py-1 sm:py-2 border border-gray-300 rounded text-sm text-gray-900"
                />
                <input
                  type="text"
                  value={newProblem.unit}
                  onChange={(e) => setNewProblem(prev => ({ ...prev, unit: e.target.value }))}
                  placeholder="단원명"
                  className="flex-1 px-2 sm:px-3 py-1 sm:py-2 border border-gray-300 rounded text-sm text-gray-900"
                />
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newProblem.category}
                  onChange={(e) => setNewProblem(prev => ({ ...prev, category: e.target.value }))}
                  placeholder="카테고리 (선택)"
                  className="flex-1 px-2 sm:px-3 py-1 sm:py-2 border border-gray-300 rounded text-sm text-gray-900"
                />
                <select
                  value={newProblem.difficulty}
                  onChange={(e) => setNewProblem(prev => ({ ...prev, difficulty: e.target.value as 'easy' | 'medium' | 'hard' }))}
                  className="px-2 sm:px-3 py-1 sm:py-2 border border-gray-300 rounded text-sm text-gray-900"
                >
                  <option value="easy">쉬움</option>
                  <option value="medium">보통</option>
                  <option value="hard">어려움</option>
                </select>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={addProblem}
                  className="px-3 sm:px-4 py-1 sm:py-2 bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1 text-sm"
                >
                  <Plus size={16} />
                  추가
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-3 sm:px-4 py-1 sm:py-2 bg-gray-500 text-white rounded hover:bg-gray-600 flex items-center gap-1 text-sm"
                >
                  <X size={16} />
                  취소
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6">
        {/* Chat */}
        <div className="bg-white rounded-lg shadow-sm border">
          <div className="p-4 sm:p-5 border-b bg-gray-50 rounded-t-lg">
            <div className="flex justify-between items-center">
              <h2 className="text-base sm:text-lg font-semibold text-gray-900 flex items-center gap-1 sm:gap-2">
                <MessageCircle className="text-blue-600" size={20} />
                학생-LLM 대화
              </h2>
              <button onClick={clearChat} className="text-xs sm:text-sm text-gray-500 hover:text-gray-700 px-2 sm:px-3 py-1 rounded hover:bg-gray-100">
                대화 초기화
              </button>
            </div>
          </div>

          <div className="h-[500px] sm:h-[550px] lg:h-[600px] overflow-y-auto p-4 sm:p-5 space-y-3 sm:space-y-4">
            {messages.length === 0 && <div className="text-center text-gray-500 py-8">학생의 첫 메시지를 기다리고 있습니다...</div>}

            {messages.map((message) => (
              <div key={message.id} className={`flex ${message.type === 'student' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[75%] sm:max-w-xs xl:max-w-md rounded-lg p-3 sm:p-4 ${
                    message.isError
                      ? 'bg-red-100 text-red-800 border border-red-200'
                      : message.type === 'student'
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-100 text-gray-900'
                  }`}
                  aria-live={message.isError ? 'assertive' : 'polite'}
                >
                  <div className="text-sm font-medium mb-1 flex items-center gap-1">
                    {message.type === 'student' && <User className="w-4 h-4" />}
                    {message.type === 'student' ? '학생' : 'LLM 권장 질문'}
                  </div>
                  <div className="text-sm whitespace-pre-wrap">{message.content}</div>
                  {message.isError && (
                    <div className="mt-2 text-xs">
                      <button
                        onClick={() => setShowErrorDetail((s) => !s)}
                        className="flex items-center gap-1 underline"
                      >
                        {showErrorDetail ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        상세 보기
                      </button>
                      {showErrorDetail && message.debug && (
                        <pre className="bg-red-50 border border-red-200 rounded p-2 overflow-auto mt-1">{message.debug}</pre>
                      )}
                    </div>
                  )}
                  <div className="text-xs opacity-70 mt-1">{message.timestamp}</div>
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 text-gray-900 rounded-lg p-3">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                    <span className="text-xs ml-2">GEMINI 응답 생성 중…</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="p-4 sm:p-5 border-t bg-gray-50">
            <div className="flex gap-3">
              <textarea
                value={currentInput}
                onChange={(e) => setCurrentInput(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder="학생 메시지를 입력하세요..."
                className="flex-1 p-3 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 text-black text-sm sm:text-base"
                rows={2}
                disabled={isLoading}
                aria-label="학생 메시지 입력"
              />
              <button
                onClick={handleSendMessage}
                disabled={!currentInput.trim() || isLoading || !apiKey}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center gap-2 text-sm sm:text-base"
                aria-label="메시지 전송"
              >
                <Send size={16} />
                전송
              </button>
            </div>
          </div>
        </div>

        {/* Diagnostic Panel */}
        <div className="bg-white rounded-lg shadow-sm border">
          <div className="p-4 sm:p-5 border-b bg-gray-50 rounded-t-lg">
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <Brain className="text-purple-600" size={20} />
              실시간 진단 결과
            </h2>
          </div>

          <div className="p-4 sm:p-5 h-[500px] sm:h-[550px] lg:h-[600px] overflow-y-auto">
            {currentDiagnostic && (
              <div className="border-2 border-purple-200 rounded-lg p-4 sm:p-5 bg-purple-50 mb-4">
                <h3 className="font-semibold text-black mb-3 flex items-center gap-2">⚡ 현재 진단 상태</h3>
                <div className="mb-3">{stagePill(currentDiagnostic.recommended_stage)}</div>

                <div className="bg-white rounded p-3 mb-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                    <div className="text-black">Survey · 지문 훑어보기: <span className="font-medium text-purple-700">{currentDiagnostic.diagnosis.survey_gist}</span></div>
                    <div className="text-black">Question · 요구 파악: <span className="font-medium text-purple-700">{currentDiagnostic.diagnosis.question_focus}</span></div>
                    <div className="text-black">Read · 근거 탐색: <span className="font-medium text-purple-700">{currentDiagnostic.diagnosis.reading_depth}</span></div>
                    <div className="text-black">Recite · 요약/설명: <span className="font-medium text-purple-700">{currentDiagnostic.diagnosis.recite_articulation}</span></div>
                    <div className="text-black">Review · 점검 태도: <span className="font-medium text-purple-700">{currentDiagnostic.diagnosis.review_accuracy}</span></div>
                    <div className="text-black">Self Confidence: <span className="font-medium text-purple-700">{currentDiagnostic.diagnosis.confidence_level}</span></div>
                  </div>
                </div>

                <div className="bg-white rounded p-3 mb-3">
                  <h4 className="font-medium text-black mb-2">추천 이유</h4>
                  <p className="text-sm text-black whitespace-pre-wrap">{currentDiagnostic.stage_reason}</p>
                </div>

                <div className="bg-white rounded p-3">
                  <h4 className="font-medium text-black mb-2">실시간 JSON</h4>
                  <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-hidden whitespace-pre-wrap break-words text-black">{JSON.stringify(currentDiagnostic, null, 2)}</pre>
                </div>
              </div>
            )}

            {messages.length === 0 ? (
              <div className="text-center text-gray-500 py-8">
                학생이 메시지를 보내면
                <br />
                진단 결과가 여기에 표시됩니다.
              </div>
            ) : (
              <div className="space-y-4">
                <h3 className="font-medium text-black border-b pb-2">진단 히스토리</h3>
                {messages
                  .filter((m) => m.type === 'llm' && m.diagnostic)
                  .map((m) => (
                    <div key={m.id} className="border rounded-lg p-4 sm:p-5 bg-gray-50">
                      <div className="mb-3">
                        <div className="flex items-center gap-2 mb-2">
                          {stagePill(m.diagnostic!.recommended_stage)}
                          <span className="text-xs text-gray-500">{m.timestamp}</span>
                        </div>
                      </div>

                      <div className="bg-white rounded p-3 mb-3">
                        <h4 className="font-medium text-black mb-2">진단 상태</h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                          <div className="text-black">Survey · 지문 훑어보기: <span className="font-medium">{m.diagnostic!.diagnosis.survey_gist}</span></div>
                          <div className="text-black">Question · 요구 파악: <span className="font-medium">{m.diagnostic!.diagnosis.question_focus}</span></div>
                          <div className="text-black">Read · 근거 탐색: <span className="font-medium">{m.diagnostic!.diagnosis.reading_depth}</span></div>
                          <div className="text-black">Recite · 요약/설명: <span className="font-medium">{m.diagnostic!.diagnosis.recite_articulation}</span></div>
                          <div className="text-black">Review · 점검 태도: <span className="font-medium">{m.diagnostic!.diagnosis.review_accuracy}</span></div>
                          <div className="text-black">Self Confidence: <span className="font-medium">{m.diagnostic!.diagnosis.confidence_level}</span></div>
                        </div>
                      </div>

                      <div className="bg-white rounded p-3">
                        <h4 className="font-medium text-black mb-2">JSON 출력</h4>
                        <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-hidden whitespace-pre-wrap break-words text-black">{JSON.stringify(m.diagnostic, null, 2)}</pre>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 시스템 프롬프트 UI 섹션 제거 - 프롬프트 내용은 코드에 유지 */}
      </div>
    </div>
  );
};

export default MathTutorDiagnostic;
