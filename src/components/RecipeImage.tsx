/* eslint-disable @next/next/no-img-element -- pictures come from many sites and Supabase storage */
import { imageSrc } from "@/lib/db";

export function RecipeImage({ url, title, className = "" }: { url: string | null; title: string; className?: string }) {
  const src = imageSrc(url);
  if (!src) {
    return (
      <div className={`flex items-center justify-center bg-brand-soft p-2 text-center text-xs font-semibold text-brand ${className}`}>
        {title}
      </div>
    );
  }
  return <img src={src} alt={title} loading="lazy" className={`object-cover ${className}`} />;
}
