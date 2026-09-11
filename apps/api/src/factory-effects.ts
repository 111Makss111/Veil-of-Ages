import { z } from 'zod';

export const motionIntensitySchema = z.enum(['calm','cinematic','expressive']);
export type MotionIntensity = z.infer<typeof motionIntensitySchema>;

export const effectIdSchema = z.enum([
  'camera.center-push',
  'atmosphere.moving-mist',
  'look.dark-fantasy-grade',
  'light.global-breathing',
  'texture.film-grain',
  'framing.vignette',
  'transition.soft-fades',
  'audio.loudness-master'
]);
export type FactoryEffectId = z.infer<typeof effectIdSchema>;

export const EFFECT_CATALOG: ReadonlyArray<{id:FactoryEffectId;label:string;detail:string;group:string}> = [
  {id:'camera.center-push',label:'Плавне наближення',detail:'Рівномірний рух до центру без бокового хитання.',group:'Камера'},
  {id:'atmosphere.moving-mist',label:'Рухомий туман',detail:'Окремий м’який атмосферний шар поверх сцени.',group:'Атмосфера'},
  {id:'look.dark-fantasy-grade',label:'Кінематографічний колір',detail:'Зелено-сланцева палітра відповідно до сцени.',group:'Колір'},
  {id:'light.global-breathing',label:'Дихання світла',detail:'Ледь помітна зміна загальної яскравості кадру.',group:'Світло'},
  {id:'texture.film-grain',label:'Плівкове зерно',detail:'Дрібна текстура, що прибирає цифрову нерухомість.',group:'Фактура'},
  {id:'framing.vignette',label:'М’яка віньєтка',detail:'Обережно спрямовує увагу до центра композиції.',group:'Композиція'},
  {id:'transition.soft-fades',label:'Плавні краї',detail:'М’яка поява і завершення зображення та музики.',group:'Переходи'},
  {id:'audio.loudness-master',label:'Підготовка звуку',detail:'Нормалізація гучності та безпечний піковий рівень.',group:'Звук'}
] as const;

export const ACTIVE_EFFECT_IDS = EFFECT_CATALOG.map(effect=>effect.id);

export const motionProfiles:Record<MotionIntensity,{zoom:number;mist:number;light:number;grain:number;vignette:string}> = {
  calm:{zoom:.035,mist:.78,light:.65,grain:.75,vignette:'PI/5.8'},
  cinematic:{zoom:.055,mist:1,light:1,grain:1,vignette:'PI/5.4'},
  expressive:{zoom:.075,mist:1.18,light:1.18,grain:1.15,vignette:'PI/5.1'}
};

export const productionPlanSchema=z.object({
  version:z.literal(1),
  source:z.enum(['baseline-rules','ai-director']),
  sceneCount:z.literal(1),
  visualPreset:z.enum(['ancient-mist','ember-glow','moonlit-ruins']),
  motionIntensity:motionIntensitySchema,
  effects:z.array(effectIdSchema).min(1).max(EFFECT_CATALOG.length).refine(items=>new Set(items).size===items.length,'Effect commands must be unique'),
  approvalRequired:z.literal(true)
}).strict();

export type ProductionPlan=z.infer<typeof productionPlanSchema>;
