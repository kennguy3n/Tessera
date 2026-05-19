export interface Template {
  id: string;
  name: string;
  templateType: string;
  description: string;
  sections: TemplateSection[];
  exportFormats: string[];
}

export interface TemplateSection {
  title: string;
  prompt: string;
  requiredSources?: {
    type: string;
    min: number;
  }[];
}
