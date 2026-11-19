import { createRoot } from "react-dom/client";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import "@/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <main className="m-12 space-y-20">
    <Carousel aria-label="Horizontal slides" className="w-64" tabIndex={0}>
      <CarouselContent>
        <CarouselItem>
          <input aria-label="Slide input" defaultValue="Sample" />
          <textarea aria-label="Slide notes" defaultValue="Sample" />
          <select aria-label="Slide option" defaultValue="First">
            <option>First</option>
            <option>Second</option>
          </select>
          <div contentEditable suppressContentEditableWarning>
            Sample
          </div>
        </CarouselItem>
        <CarouselItem>Last horizontal slide</CarouselItem>
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
    <Carousel
      aria-label="Vertical slides"
      className="w-64 [&_[data-slot=carousel-content]]:h-40"
      orientation="vertical"
      tabIndex={0}
    >
      <CarouselContent className="h-full">
        <CarouselItem>First vertical slide</CarouselItem>
        <CarouselItem>Last vertical slide</CarouselItem>
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  </main>,
);
