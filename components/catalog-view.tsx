"use client";

import { useMemo, useState } from "react";
import { Box, CheckCircle2, ExternalLink, FileBox, FileCode2, Loader2, MoveRight, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { ModelViewport } from "@/components/model-viewport";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  fetchRepositoryFile,
  listCatalogComponents,
  moveCatalogComponent,
  parseRepository,
  type CatalogComponent,
  type GitHubConfig,
  type RepositoryInfo,
} from "@/lib/github";
import type { IntakeAsset } from "@/lib/kicad";

type Props = {
  repositoryInfo: RepositoryInfo | null;
  repositoryInput: string;
  branch: string;
  token: string;
  onConnect: () => void;
};

const preferredSections = ["RF", "Custom", "Modules"];

function configFor(props: Props): GitHubConfig {
  const { owner, repo } = parseRepository(props.repositoryInput);
  return { owner, repo, branch: props.repositoryInfo!.branch || props.branch, token: props.token };
}

function CatalogModel({ component, config }: { component: CatalogComponent; config: GitHubConfig }) {
  const model = component.manifest.assets.find((asset) => asset.type === "model");
  const [asset, setAsset] = useState<IntakeAsset | null>(null);
  const [busy, setBusy] = useState(false);
  if (!model) return <span className="text-sm text-slate-600">No model</span>;

  async function load() {
    setBusy(true);
    try {
      const bytes = await fetchRepositoryFile(config, model!.target_path);
      setAsset({
        id: `${component.manifestPath}-model`,
        name: model!.target_path.split("/").at(-1)!,
        sourceName: model!.source_file,
        kind: "model",
        bytes,
        warnings: [],
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The model could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  return asset ? (
    <div className="catalog-model min-w-[15rem]"><ModelViewport asset={asset} /></div>
  ) : (
    <button
      type="button"
      onClick={load}
      disabled={busy}
      className="group grid h-28 w-52 place-items-center rounded-lg border border-slate-700 bg-[linear-gradient(rgba(71,85,105,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(71,85,105,.08)_1px,transparent_1px),#080d14] bg-[size:18px_18px] text-slate-500 transition hover:border-teal-400/35 hover:text-teal-200"
    >
      <span className="text-center">
        {busy ? <Loader2 className="mx-auto size-5 animate-spin" /> : <Box className="mx-auto size-6" />}
        <span className="mt-2 block text-sm">{busy ? "Loading model…" : "Load 3D preview"}</span>
      </span>
    </button>
  );
}

export function CatalogView(props: Props) {
  const [components, setComponents] = useState<CatalogComponent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [movingPath, setMovingPath] = useState("");

  const sections = useMemo(() => {
    const discovered = components.map((item) => item.manifest.library.category);
    return [...new Set([...preferredSections, ...discovered])];
  }, [components]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return components;
    return components.filter(({ manifest }) => [
      manifest.component.library_name,
      manifest.component.title,
      manifest.component.description,
      manifest.component.manufacturer,
      manifest.component.mpn,
      manifest.component.package,
      manifest.library.category,
    ].some((value) => value?.toLowerCase().includes(query)));
  }, [components, search]);

  async function refresh() {
    if (!props.repositoryInfo) return props.onConnect();
    setLoading(true);
    try {
      const result = await listCatalogComponents(configFor(props));
      setComponents(result);
      setLoaded(true);
      toast.success(`${result.length} component${result.length === 1 ? "" : "s"} loaded`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The catalog could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  async function move(component: CatalogComponent, toCategory: string) {
    if (!props.repositoryInfo || toCategory === component.manifest.library.category) return;
    setMovingPath(component.manifestPath);
    try {
      await moveCatalogComponent(configFor(props), component, toCategory);
      setComponents(await listCatalogComponents(configFor(props)));
      toast.success(`${component.manifest.component.library_name} moved to ${toCategory}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The component could not be moved.");
    } finally {
      setMovingPath("");
    }
  }

  if (!props.repositoryInfo) {
    return (
      <section className="panel grid min-h-[32rem] place-items-center p-8 text-center">
        <div className="max-w-md">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-slate-700 bg-slate-950/60 text-teal-300"><Box /></div>
          <h1 className="mt-5 text-2xl font-semibold text-slate-100">Connect your library to open the catalog</h1>
          <p className="mt-2 text-base leading-7 text-slate-400">The catalog reads the component manifests already stored in your Git repository.</p>
          <Button onClick={props.onConnect} className="mt-6 bg-teal-300 text-slate-950 hover:bg-teal-200">Connect repository</Button>
        </div>
      </section>
    );
  }

  return (
    <div>
      <section className="mb-6 flex flex-col gap-4 border-b border-slate-800/80 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 font-mono text-xs font-medium uppercase tracking-[0.18em] text-teal-300/80">Library catalog</p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50 sm:text-3xl">Browse every trusted component.</h1>
          <p className="mt-2 text-base text-slate-400">Grouped by library section and backed directly by Git.</p>
        </div>
        <div className="flex w-full gap-2 lg:w-auto">
          <div className="relative min-w-0 flex-1 lg:w-80">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, MPN, package…" className="h-10 border-slate-700 bg-slate-950/70 pl-9" />
          </div>
          <Button onClick={refresh} disabled={loading} variant="outline" className="border-slate-700 bg-slate-900/70">
            <RefreshCw className={loading ? "animate-spin" : ""} /> {loaded ? "Refresh" : "Load catalog"}
          </Button>
        </div>
      </section>

      {!loaded ? (
        <section className="panel grid min-h-72 place-items-center p-8 text-center">
          <div><Box className="mx-auto size-7 text-slate-600" /><p className="mt-3 text-slate-400">Load the manifests from {props.repositoryInfo.fullName}.</p></div>
        </section>
      ) : visible.length === 0 ? (
        <section className="panel grid min-h-72 place-items-center p-8 text-center">
          <div><Search className="mx-auto size-7 text-slate-600" /><p className="mt-3 text-slate-400">No catalog components match this search.</p></div>
        </section>
      ) : (
        <div className="space-y-8">
          <nav className="scrollbar-none sticky top-0 z-20 -mx-4 flex gap-2 overflow-x-auto border-y border-slate-800 bg-[#080b10]/95 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            {sections.filter((section) => visible.some((item) => item.manifest.library.category === section)).map((section) => (
              <a key={section} href={`#section-${section}`} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-300 hover:border-teal-400/35 hover:text-teal-200">
                {section} <span className="ml-1 font-mono text-xs text-slate-600">{visible.filter((item) => item.manifest.library.category === section).length}</span>
              </a>
            ))}
          </nav>

          {sections.map((section) => {
            const rows = visible.filter((item) => item.manifest.library.category === section);
            if (!rows.length) return null;
            return (
              <section key={section} id={`section-${section}`} className="panel scroll-mt-20 overflow-hidden">
                <div className="panel-heading">
                  <div><span className="panel-kicker">SECTION</span><h2 className="panel-title text-lg">{section}</h2></div>
                  <Badge variant="outline" className="border-slate-700 bg-slate-900 text-slate-300">{rows.length} component{rows.length === 1 ? "" : "s"}</Badge>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1180px] text-left">
                    <thead className="border-b border-slate-800 bg-slate-950/45 font-mono text-[11px] uppercase tracking-[0.12em] text-slate-600">
                      <tr><th className="px-5 py-3 font-medium">Name</th><th className="px-4 py-3 font-medium">Description</th><th className="px-4 py-3 font-medium">Package</th><th className="px-4 py-3 font-medium">Assets</th><th className="px-4 py-3 font-medium">3D preview</th><th className="px-4 py-3 font-medium">Status</th><th className="px-5 py-3 font-medium">Move to</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80">
                      {rows.map((component) => {
                        const { manifest } = component;
                        return (
                          <tr key={component.manifestPath} className="align-top bg-slate-950/15">
                            <td className="px-5 py-5">
                              <div className="text-sm font-semibold text-teal-200">{manifest.component.title || manifest.component.library_name}</div>
                              {manifest.component.title && <div className="mt-1 font-mono text-xs text-slate-500">{manifest.component.library_name}</div>}
                              <div className="mt-1 text-sm text-slate-400">{manifest.component.manufacturer || "Unknown manufacturer"}</div>
                              <div className="mt-1 font-mono text-xs text-slate-600">{manifest.component.mpn}</div>
                              {manifest.provenance.source_url && <a href={manifest.provenance.source_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-teal-300">Source <ExternalLink className="size-3" /></a>}
                            </td>
                            <td className="max-w-sm px-4 py-5 text-sm leading-6 text-slate-400">{manifest.component.description || "No description"}</td>
                            <td className="px-4 py-5 font-mono text-xs text-slate-400">{manifest.component.package || "—"}</td>
                            <td className="px-4 py-5"><div className="flex flex-wrap gap-1.5">
                              {manifest.library.symbol && <Badge variant="outline" className="border-cyan-400/20 text-cyan-300"><FileCode2 /> Symbol</Badge>}
                              {manifest.library.footprints.length > 0 && <Badge variant="outline" className="border-amber-400/20 text-amber-200"><FileBox /> {manifest.library.footprints.length} footprint{manifest.library.footprints.length === 1 ? "" : "s"}</Badge>}
                              {manifest.assets.some((asset) => asset.type === "model") && <Badge variant="outline" className="border-teal-400/20 text-teal-300"><Box /> 3D</Badge>}
                            </div></td>
                            <td className="px-4 py-4"><CatalogModel component={component} config={configFor(props)} /></td>
                            <td className="px-4 py-5"><span className="inline-flex items-center gap-1.5 text-sm text-slate-300"><CheckCircle2 className="size-4 text-emerald-400" />{manifest.library.verified}</span></td>
                            <td className="px-5 py-4">
                              <Select value={section} disabled={movingPath === component.manifestPath} onValueChange={(value) => value && void move(component, value)}>
                                <SelectTrigger className="w-40 border-slate-700 bg-slate-900"><MoveRight className="size-4" /><SelectValue /></SelectTrigger>
                                <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">{sections.map((target) => <SelectItem key={target} value={target}>{target}</SelectItem>)}</SelectContent>
                              </Select>
                              {movingPath === component.manifestPath && <span className="mt-2 flex items-center gap-2 text-xs text-slate-500"><Loader2 className="size-3 animate-spin" /> Committing move…</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
