"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Check, EllipsisVertical, ExternalLink, FileBox, FileCode2, FileText, Link2, Loader2, MoveRight, Pencil, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { ModelViewport } from "@/components/model-viewport";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { displayCategory, libraryCategories, sanitizeCatalogTitle, sanitizeManufacturerName } from "@/lib/categories";
import {
  fetchRepositoryFile,
  listCatalogComponents,
  linkCatalogFootprintModel,
  moveCatalogComponent,
  parseRepository,
  updateCatalogComponentMetadata,
  type CatalogComponent,
  type CatalogMetadataUpdate,
  type GitHubConfig,
  type RepositoryInfo,
} from "@/lib/github";
import { footprintModelReferences, kicadModelPath, type IntakeAsset } from "@/lib/kicad";

type Props = {
  repositoryInfo: RepositoryInfo | null;
  repositoryInput: string;
  branch: string;
  token: string;
  onConnect: () => void;
};

const preferredSections = libraryCategories.map((category) => category.id);

const emptyEdit: CatalogMetadataUpdate = {
  manufacturer: "",
  mpn: "",
  library_name: "",
  title: "",
  description: "",
  package: "",
  datasheet: "",
};

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
  const [editing, setEditing] = useState<CatalogComponent | null>(null);
  const [editValues, setEditValues] = useState<CatalogMetadataUpdate>(emptyEdit);
  const [editBusy, setEditBusy] = useState(false);
  const [moveTarget, setMoveTarget] = useState("");
  const [moveItem, setMoveItem] = useState<CatalogComponent | null>(null);
  const [linkItem, setLinkItem] = useState<CatalogComponent | null>(null);
  const [linkFootprint, setLinkFootprint] = useState("");
  const [linkModel, setLinkModel] = useState("");
  const [linkReferences, setLinkReferences] = useState<string[] | null>(null);
  const [linkReadBusy, setLinkReadBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [selectedSection, setSelectedSection] = useState(preferredSections[0] ?? "");

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

  const populatedSections = useMemo(
    () => sections.filter((section) => components.some((item) => item.manifest.library.category === section)),
    [components, sections],
  );

  const rows = useMemo(
    () => visible.filter((item) => item.manifest.library.category === selectedSection),
    [selectedSection, visible],
  );

  useEffect(() => {
    if (!props.repositoryInfo) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      const { owner, repo } = parseRepository(props.repositoryInput);
      void listCatalogComponents({ owner, repo, branch: props.repositoryInfo!.branch || props.branch, token: props.token })
        .then((result) => {
          if (cancelled) return;
          setComponents(result);
          const available = [...new Set(result.map((item) => item.manifest.library.category))];
          setSelectedSection((current) => available.includes(current) ? current : (available[0] ?? ""));
          setLoaded(true);
        })
        .catch((error) => {
          if (!cancelled) toast.error(error instanceof Error ? error.message : "The catalog could not be loaded.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => { cancelled = true; };
  }, [props.branch, props.repositoryInfo, props.repositoryInput, props.token]);

  async function refresh() {
    if (!props.repositoryInfo) return props.onConnect();
    setLoading(true);
    try {
      const result = await listCatalogComponents(configFor(props));
      setComponents(result);
      const available = [...new Set(result.map((item) => item.manifest.library.category))];
      setSelectedSection((current) => available.includes(current) ? current : (available[0] ?? ""));
      setLoaded(true);
      toast.success(`${result.length} component${result.length === 1 ? "" : "s"} loaded`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The catalog could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  function openEdit(component: CatalogComponent) {
    const { manufacturer, mpn, library_name, title, description, package: packageName, datasheet } = component.manifest.component;
    setEditValues({
      manufacturer: manufacturer || "",
      mpn: mpn || "",
      library_name: library_name || "",
      title: title || "",
      description: description || "",
      package: packageName || "",
      datasheet: datasheet || "",
    });
    setEditing(component);
  }

  async function saveEdit() {
    if (!editing) return;
    setEditBusy(true);
    try {
      await updateCatalogComponentMetadata(configFor(props), editing, editValues);
      setComponents(await listCatalogComponents(configFor(props)));
      setEditing(null);
      toast.success(`${editValues.library_name} details updated`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The component details could not be updated.");
    } finally {
      setEditBusy(false);
    }
  }

  function openMove(component: CatalogComponent) {
    setMoveItem(component);
    setMoveTarget(component.manifest.library.category);
  }

  async function move(component: CatalogComponent, toCategory: string) {
    if (!props.repositoryInfo || toCategory === component.manifest.library.category) return;
    setMovingPath(component.manifestPath);
    try {
      await moveCatalogComponent(configFor(props), component, toCategory);
      setComponents(await listCatalogComponents(configFor(props)));
      setSelectedSection(toCategory);
      setMoveItem(null);
      toast.success(`${component.manifest.component.library_name} moved to ${displayCategory(toCategory)}`);
    } catch (error) {
      try {
        setComponents(await listCatalogComponents(configFor(props)));
      } catch {
        // Preserve the move error when the follow-up refresh also fails.
      }
      toast.error(error instanceof Error ? error.message : "The component could not be moved.");
    } finally {
      setMovingPath("");
    }
  }

  async function loadLinkReferences(footprintPath: string) {
    if (!footprintPath) return setLinkReferences(null);
    setLinkReadBusy(true);
    setLinkReferences(null);
    try {
      const bytes = await fetchRepositoryFile(configFor(props), footprintPath);
      setLinkReferences(footprintModelReferences(new TextDecoder().decode(bytes)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The footprint could not be checked.");
    } finally {
      setLinkReadBusy(false);
    }
  }

  function openLink(component: CatalogComponent) {
    const footprintPath = component.manifest.assets.find((asset) => asset.type === "footprint")?.target_path ?? "";
    const modelPath = component.manifest.assets.find((asset) => asset.type === "model")?.target_path ?? "";
    setLinkItem(component);
    setLinkFootprint(footprintPath);
    setLinkModel(modelPath);
    void loadLinkReferences(footprintPath);
  }

  async function saveLink() {
    if (!linkItem || !linkFootprint || !linkModel) return;
    setLinkBusy(true);
    try {
      const result = await linkCatalogFootprintModel(configFor(props), linkItem, linkFootprint, linkModel);
      setComponents(await listCatalogComponents(configFor(props)));
      setLinkItem(null);
      toast.success(result.alreadyLinked ? "This model was already linked" : "3D model linked to footprint");
    } catch (error) {
      try {
        setComponents(await listCatalogComponents(configFor(props)));
      } catch {
        // Preserve the linking error when the follow-up refresh also fails.
      }
      toast.error(error instanceof Error ? error.message : "The 3D model could not be linked.");
    } finally {
      setLinkBusy(false);
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
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50 sm:text-3xl">Browse every component.</h1>
          <p className="mt-2 text-base text-slate-400">Browse one library category at a time, backed directly by Git.</p>
        </div>
        <div className="flex w-full gap-2 lg:w-auto">
          <div className="relative min-w-0 flex-1 lg:w-80">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, MPN, package…" className="h-10 border-slate-700 bg-slate-950/70 pl-9" />
          </div>
          <Button onClick={() => void refresh()} disabled={loading} variant="outline" className="border-slate-700 bg-slate-900/70">
            <RefreshCw className={loading ? "animate-spin" : ""} /> {loaded ? "Refresh" : "Load catalog"}
          </Button>
        </div>
      </section>

      {!loaded ? (
        <section className="panel grid min-h-72 place-items-center p-8 text-center">
          <div><Box className="mx-auto size-7 text-slate-600" /><p className="mt-3 text-slate-400">Load the manifests from {props.repositoryInfo.fullName}.</p></div>
        </section>
      ) : components.length === 0 ? (
        <section className="panel grid min-h-72 place-items-center p-8 text-center">
          <div><Box className="mx-auto size-7 text-slate-600" /><p className="mt-3 text-slate-400">This catalog does not contain any components yet.</p></div>
        </section>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <label className="text-sm font-medium text-slate-300" htmlFor="catalog-category">Category</label>
            <Select value={selectedSection} onValueChange={setSelectedSection}>
              <SelectTrigger id="catalog-category" className="w-full border-slate-700 bg-slate-950/70 sm:w-80">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                {populatedSections.map((section) => (
                  <SelectItem key={section} value={section}>
                    {displayCategory(section)} ({components.filter((item) => item.manifest.library.category === section).length})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {rows.length === 0 ? (
            <section className="panel grid min-h-72 place-items-center p-8 text-center">
              <div><Search className="mx-auto size-7 text-slate-600" /><p className="mt-3 text-slate-400">No components in {displayCategory(selectedSection)} match this search.</p></div>
            </section>
          ) : (
            <section className="panel overflow-hidden">
                <div className="panel-heading">
                  <div><span className="panel-kicker">CATEGORY</span><h2 className="panel-title text-lg">{displayCategory(selectedSection)}</h2></div>
                  <Badge variant="outline" className="border-slate-700 bg-slate-900 text-slate-300">{rows.length} component{rows.length === 1 ? "" : "s"}</Badge>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1060px] text-left">
                    <thead className="border-b border-slate-800 bg-slate-950/45 font-mono text-[11px] uppercase tracking-[0.12em] text-slate-600">
                      <tr><th className="px-5 py-3 font-medium">Name</th><th className="px-4 py-3 font-medium">Description</th><th className="px-4 py-3 font-medium">Package</th><th className="px-4 py-3 font-medium">Assets</th><th className="px-4 py-3 font-medium">3D preview</th><th className="px-5 py-3 text-right font-medium">Actions</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80">
                      {rows.map((component) => {
                        const { manifest } = component;
                        const displayLibraryName = sanitizeCatalogTitle(manifest.component.library_name)
                          || sanitizeCatalogTitle(manifest.component.mpn)
                          || "Component";
                        const displayTitle = sanitizeCatalogTitle(manifest.component.title || "") || displayLibraryName;
                        return (
                          <tr key={component.manifestPath} className="align-top bg-slate-950/15">
                            <td className="px-5 py-5">
                              <div className="text-sm font-semibold text-teal-200">{displayTitle}</div>
                              {displayTitle !== displayLibraryName && <div className="mt-1 font-mono text-xs text-slate-500">{displayLibraryName}</div>}
                              <div className="mt-1 text-sm text-slate-400">{sanitizeManufacturerName(manifest.component.manufacturer || "") || "Unknown manufacturer"}</div>
                              <div className="mt-1 font-mono text-xs text-slate-600">{manifest.component.mpn}</div>
                              {manifest.provenance.source_url && <a href={manifest.provenance.source_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-teal-300">Source <ExternalLink className="size-3" /></a>}
                            </td>
                            <td className="max-w-sm px-4 py-5 text-sm leading-6 text-slate-400">{manifest.component.description || "No description"}</td>
                            <td className="px-4 py-5 font-mono text-xs text-slate-400">{manifest.component.package || "—"}</td>
                            <td className="px-4 py-5"><div className="flex flex-wrap gap-1.5">
                              {manifest.library.symbol && <Badge variant="outline" className="border-cyan-400/20 text-cyan-300"><FileCode2 /> Symbol</Badge>}
                              {manifest.library.footprints.length > 0 && <Badge variant="outline" className="border-amber-400/20 text-amber-200"><FileBox /> {manifest.library.footprints.length} footprint{manifest.library.footprints.length === 1 ? "" : "s"}</Badge>}
                              {manifest.assets.some((asset) => asset.type === "model") && <Badge variant="outline" className="border-teal-400/20 text-teal-300"><Box /> 3D</Badge>}
                              {(Boolean(manifest.component.datasheet) || manifest.assets.some((asset) => asset.type === "datasheet")) && <Badge variant="outline" className="border-violet-400/20 text-violet-300"><FileText /> Datasheet</Badge>}
                            </div></td>
                            <td className="px-4 py-4"><CatalogModel component={component} config={configFor(props)} /></td>
                            <td className="px-5 py-4 text-right">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${manifest.component.library_name}`} disabled={movingPath === component.manifestPath} className="text-slate-500 hover:bg-slate-800 hover:text-slate-100">
                                    {movingPath === component.manifestPath ? <Loader2 className="animate-spin" /> : <EllipsisVertical />}
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="border-slate-700 bg-slate-900 text-slate-200">
                                  <DropdownMenuItem onSelect={() => openEdit(component)} className="focus:bg-slate-800 focus:text-slate-50"><Pencil /> Edit details</DropdownMenuItem>
                                  <DropdownMenuItem
                                    onSelect={() => openLink(component)}
                                    disabled={!manifest.assets.some((asset) => asset.type === "footprint") || !manifest.assets.some((asset) => asset.type === "model")}
                                    className="focus:bg-slate-800 focus:text-slate-50"
                                  ><Link2 /> Link 3D model</DropdownMenuItem>
                                  <DropdownMenuItem onSelect={() => openMove(component)} className="focus:bg-slate-800 focus:text-slate-50"><MoveRight /> Move section</DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
            </section>
          )}
        </div>
      )}

      <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open && !editBusy) setEditing(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto border-slate-700 bg-slate-900 text-slate-100 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit component details</DialogTitle>
            <DialogDescription className="text-slate-400">
              Update catalog metadata for <span className="font-mono text-slate-300">{editing?.manifest.component.library_name}</span>. KiCad asset names are unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <label className="grid gap-2 text-sm text-slate-300">Manufacturer
              <Input value={editValues.manufacturer} onChange={(event) => setEditValues((current) => ({ ...current, manufacturer: sanitizeManufacturerName(event.target.value) }))} className="border-slate-700 bg-slate-950/70" />
            </label>
            <label className="grid gap-2 text-sm text-slate-300">Manufacturer part number
              <Input value={editValues.mpn} onChange={(event) => setEditValues((current) => ({ ...current, mpn: event.target.value }))} className="border-slate-700 bg-slate-950/70 font-mono" />
            </label>
            <label className="grid gap-2 text-sm text-slate-300 sm:col-span-2">Functional title
              <Input value={editValues.title || ""} onChange={(event) => setEditValues((current) => ({ ...current, title: event.target.value }))} className="border-slate-700 bg-slate-950/70" />
            </label>
            <label className="grid gap-2 text-sm text-slate-300 sm:col-span-2">Description
              <textarea value={editValues.description} onChange={(event) => setEditValues((current) => ({ ...current, description: event.target.value }))} rows={3} className="w-full resize-none rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm leading-6 text-slate-100 outline-none focus:border-teal-400/60 focus:ring-3 focus:ring-teal-400/10" />
            </label>
            <label className="grid gap-2 text-sm text-slate-300">Package
              <Input value={editValues.package} onChange={(event) => setEditValues((current) => ({ ...current, package: event.target.value }))} className="border-slate-700 bg-slate-950/70 font-mono" />
            </label>
            <label className="grid gap-2 text-sm text-slate-300">Datasheet URL
              <Input value={editValues.datasheet} onChange={(event) => setEditValues((current) => ({ ...current, datasheet: event.target.value }))} className="border-slate-700 bg-slate-950/70" />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={editBusy} className="border-slate-700 bg-slate-950/50">Cancel</Button>
            <Button onClick={() => void saveEdit()} disabled={editBusy || !editValues.mpn.trim()} className="bg-teal-300 text-slate-950 hover:bg-teal-200">
              {editBusy && <Loader2 className="animate-spin" />} Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(linkItem)} onOpenChange={(open) => { if (!open && !linkBusy) setLinkItem(null); }}>
        <DialogContent className="border-slate-700 bg-slate-900 text-slate-100 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Link 3D model</DialogTitle>
            <DialogDescription className="text-slate-400">
              Attach a model already stored with <span className="font-mono text-slate-300">{linkItem?.manifest.component.library_name}</span>. Existing scale, rotation, and offset values are preserved.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 py-2">
            <label className="grid gap-2 text-sm text-slate-300">Footprint
              <Select value={linkFootprint} onValueChange={(value) => { setLinkFootprint(value ?? ""); void loadLinkReferences(value ?? ""); }}>
                <SelectTrigger className="w-full border-slate-700 bg-slate-950/70"><SelectValue placeholder="Choose a footprint" /></SelectTrigger>
                <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                  {linkItem?.manifest.assets.filter((asset) => asset.type === "footprint").map((asset) => (
                    <SelectItem key={asset.target_path} value={asset.target_path}>{asset.target_path.split("/").at(-1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-2 text-sm text-slate-300">3D model
              <Select value={linkModel} onValueChange={(value) => setLinkModel(value ?? "")}>
                <SelectTrigger className="w-full border-slate-700 bg-slate-950/70"><SelectValue placeholder="Choose a model" /></SelectTrigger>
                <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                  {linkItem?.manifest.assets.filter((asset) => asset.type === "model").map((asset) => (
                    <SelectItem key={asset.target_path} value={asset.target_path}>{asset.target_path.split("/").at(-1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <div className="rounded-xl border border-slate-800 bg-slate-950/55 p-4">
              <div className="text-xs text-slate-500">KiCad path</div>
              <div className="mt-1 break-all font-mono text-xs text-teal-200">{linkModel ? kicadModelPath(linkModel) : "Choose a model"}</div>
              <div className="mt-4 text-xs text-slate-500">Status</div>
              <div className="mt-1 flex items-center gap-2 text-sm text-slate-300">
                {linkReadBusy ? <Loader2 className="size-4 animate-spin text-slate-500" /> : linkModel && linkReferences?.includes(kicadModelPath(linkModel)) ? <Check className="size-4 text-emerald-300" /> : <Link2 className="size-4 text-amber-300" />}
                {linkReadBusy ? "Checking footprint…" : linkModel && linkReferences?.includes(kicadModelPath(linkModel)) ? "Already linked" : linkReferences?.length ? "Existing model reference will be replaced" : "Ready to add model reference"}
              </div>
              {Boolean(linkReferences?.length) && (
                <div className="mt-3 space-y-1 border-t border-slate-800 pt-3">
                  <div className="text-xs text-slate-600">Current reference</div>
                  {linkReferences!.map((reference) => <div key={reference} className="break-all font-mono text-[11px] text-slate-500">{reference}</div>)}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkItem(null)} disabled={linkBusy} className="border-slate-700 bg-slate-950/50">Cancel</Button>
            <Button onClick={() => void saveLink()} disabled={linkBusy || linkReadBusy || !linkFootprint || !linkModel} className="bg-teal-300 text-slate-950 hover:bg-teal-200">
              {linkBusy && <Loader2 className="animate-spin" />} Link model
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(moveItem)} onOpenChange={(open) => { if (!open && !movingPath) setMoveItem(null); }}>
        <DialogContent className="border-slate-700 bg-slate-900 text-slate-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move component</DialogTitle>
            <DialogDescription className="text-slate-400">
              Move <span className="font-mono text-slate-300">{moveItem?.manifest.component.library_name}</span> and its assets to another KiCad library section.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select value={moveTarget} onValueChange={setMoveTarget}>
              <SelectTrigger className="w-full border-slate-700 bg-slate-950/70"><SelectValue placeholder="Choose a section" /></SelectTrigger>
              <SelectContent className="border-slate-700 bg-slate-900 text-slate-100">
                {sections.map((target) => <SelectItem key={target} value={target}>{displayCategory(target)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveItem(null)} disabled={Boolean(movingPath)} className="border-slate-700 bg-slate-950/50">Cancel</Button>
            <Button onClick={() => moveItem && void move(moveItem, moveTarget)} disabled={!moveItem || Boolean(movingPath) || moveTarget === moveItem.manifest.library.category} className="bg-teal-300 text-slate-950 hover:bg-teal-200">
              {movingPath && <Loader2 className="animate-spin" />} Move component
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
