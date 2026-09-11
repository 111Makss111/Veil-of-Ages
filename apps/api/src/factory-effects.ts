import { z } from 'zod';

export const motionIntensitySchema = z.enum(['calm','cinematic','expressive']);
export type MotionIntensity = z.infer<typeof motionIntensitySchema>;

export const effectIdSchema = z.enum([
  'story.three-scenes',
  'camera.center-push',
  'atmosphere.moving-mist',
  'atmosphere.drifting-particles',
  'look.dark-fantasy-grade',
  'light.global-breathing',
  'texture.film-grain',
  'framing.vignette',
  'transition.scene-crossfades',
  'transition.soft-fades',
  'audio.loudness-master'
]);
export type FactoryEffectId = z.infer<typeof effectIdSchema>;

export const EFFECT_CATALOG: ReadonlyArray<{id:FactoryEffectId;label:string;detail:string;group:string}> = [
  {id:'story.three-scenes',label:'Три пов’язані сцени',detail:'Вступ, розвиток і кульмінація замість однієї нерухомої картинки.',group:'Історія'},
  {id:'atmosphere.moving-mist',label:'Рухомий туман',detail:'Помітний м’який атмосферний шар із повільним дрейфом.',group:'Атмосфера'},
  {id:'atmosphere.drifting-particles',label:'Сніг, попіл або жарини',detail:'Повільні частинки відповідно до характеру вибраного світу.',group:'Атмосфера'},
  {id:'look.dark-fantasy-grade',label:'Кінематографічний колір',detail:'Зелено-сланцева палітра відповідно до сцени.',group:'Колір'},
  {id:'light.global-breathing',label:'Дихання світла',detail:'Ледь помітна зміна загальної яскравості кадру.',group:'Світло'},
  {id:'texture.film-grain',label:'Плівкове зерно',detail:'Дрібна текстура, що прибирає цифрову нерухомість.',group:'Фактура'},
  {id:'framing.vignette',label:'М’яка віньєтка',detail:'Обережно спрямовує увагу до центра композиції.',group:'Композиція'},
  {id:'transition.scene-crossfades',label:'Переходи між сценами',detail:'М’яке перетікання між трьома частинами історії.',group:'Переходи'},
  {id:'transition.soft-fades',label:'Плавний початок і фінал',detail:'М’яка поява і завершення зображення та музики.',group:'Переходи'},
  {id:'audio.loudness-master',label:'Підготовка звуку',detail:'Нормалізація гучності та безпечний піковий рівень.',group:'Звук'}
] as const;

export const ACTIVE_EFFECT_IDS = EFFECT_CATALOG.map(effect=>effect.id);

export const motionProfiles:Record<MotionIntensity,{zoom:number;mist:number;particles:number;light:number;grain:number;vignette:string}> = {
  calm:{zoom:.025,mist:.72,particles:.65,light:.65,grain:.75,vignette:'PI/5.8'},
  cinematic:{zoom:.04,mist:1,particles:1,light:1,grain:1,vignette:'PI/5.4'},
  expressive:{zoom:.06,mist:1.2,particles:1.25,light:1.18,grain:1.15,vignette:'PI/5.1'}
};

export const productionPlanSchema=z.object({
  version:z.literal(2),
  source:z.enum(['baseline-rules','ai-director']),
  sceneCount:z.union([z.literal(1),z.literal(3)]),
  visualPreset:z.enum(['ancient-mist','ember-glow','moonlit-ruins']),
  motionIntensity:motionIntensitySchema,
  effects:z.array(effectIdSchema).min(1).max(EFFECT_CATALOG.length).refine(items=>new Set(items).size===items.length,'Effect commands must be unique'),
  approvalRequired:z.literal(true)
}).strict();

export type ProductionPlan=z.infer<typeof productionPlanSchema>;
