#!/usr/bin/env python3
"""Deterministic, dependency-free Xcode project for the local iPhone app."""
from pathlib import Path
import hashlib, json, plistlib, shutil
root=Path(__file__).resolve().parents[1]
app=root/'QiCanIScreenwrite'; project=root/'QiCanIScreenwrite.xcodeproj'
project.mkdir(exist_ok=True)
def uid(name): return hashlib.sha256(name.encode()).hexdigest()[:24].upper()
objects={}
def obj(key_name,isa,**fields):
 key=uid(key_name);objects[key]={'isa':isa,**fields};return key
sources=[];resources=[];refs=[]
for p in sorted(app.rglob('*.swift')):
 rel=str(p.relative_to(root));r=obj(rel,'PBXFileReference',lastKnownFileType='sourcecode.swift',path=rel,sourceTree='<group>');refs.append(r);sources.append(obj('build:'+rel,'PBXBuildFile',fileRef=r))
for p,kind in [(app/'Resources/Assets.xcassets','folder.assetcatalog'),(app/'Resources/film-language.json','text.json'),(app/'Resources/PrivacyInfo.xcprivacy','text.xml')]:
 rel=str(p.relative_to(root));r=obj(rel,'PBXFileReference',lastKnownFileType=kind,path=rel,sourceTree='<group>');refs.append(r);resources.append(obj('build:'+rel,'PBXBuildFile',fileRef=r))
package=obj('core-package','XCLocalSwiftPackageReference',relativePath='Core')
product=obj('core-product','XCSwiftPackageProductDependency',package=package,productName='ScreenwriteCore')
framework=obj('core-build','PBXBuildFile',productRef=product)
appProduct=obj('app-product','PBXFileReference',explicitFileType='wrapper.application',includeInIndex=0,path='QiCanIScreenwrite.app',sourceTree='BUILT_PRODUCTS_DIR')
products=obj('products','PBXGroup',children=[appProduct],name='Products',sourceTree='<group>')
main=obj('main','PBXGroup',children=refs+[products],sourceTree='<group>')
sourcePhase=obj('sources','PBXSourcesBuildPhase',buildActionMask=2147483647,files=sources,runOnlyForDeploymentPostprocessing=0)
resourcePhase=obj('resources','PBXResourcesBuildPhase',buildActionMask=2147483647,files=resources,runOnlyForDeploymentPostprocessing=0)
frameworkPhase=obj('frameworks','PBXFrameworksBuildPhase',buildActionMask=2147483647,files=[framework],runOnlyForDeploymentPostprocessing=0)
configLists={}
for scope in ['project','app']:
 configs=[]
 for mode in ['Debug','Release']:
  settings={'IPHONEOS_DEPLOYMENT_TARGET':'17.0','SDKROOT':'iphoneos','SWIFT_VERSION':'5.0','CLANG_ENABLE_MODULES':'YES','SWIFT_STRICT_CONCURRENCY':'targeted'}
  if scope=='project': settings.update({'ONLY_ACTIVE_ARCH':'YES' if mode=='Debug' else 'NO','SWIFT_OPTIMIZATION_LEVEL':'-Onone' if mode=='Debug' else '-O','DEBUG_INFORMATION_FORMAT':'dwarf' if mode=='Debug' else 'dwarf-with-dsym','ENABLE_TESTABILITY':'YES' if mode=='Debug' else 'NO','SWIFT_ACTIVE_COMPILATION_CONDITIONS':'DEBUG' if mode=='Debug' else ''})
  else: settings.update({'PRODUCT_NAME':'QiCanIScreenwrite','PRODUCT_BUNDLE_IDENTIFIER':'com.hampton.qicaniscreenwrite.iphone','INFOPLIST_FILE':'QiCanIScreenwrite/Info.plist','GENERATE_INFOPLIST_FILE':'NO','CODE_SIGN_STYLE':'Automatic','TARGETED_DEVICE_FAMILY':'1','ASSETCATALOG_COMPILER_APPICON_NAME':'AppIcon','SUPPORTED_PLATFORMS':'iphoneos iphonesimulator','SUPPORTS_MACCATALYST':'NO','CURRENT_PROJECT_VERSION':'2','MARKETING_VERSION':'0.2.0','LD_RUNPATH_SEARCH_PATHS':['$(inherited)','@executable_path/Frameworks']})
  configs.append(obj(scope+mode,'XCBuildConfiguration',buildSettings=settings,name=mode))
 configLists[scope]=obj(scope+'configs','XCConfigurationList',buildConfigurations=configs,defaultConfigurationIsVisible=0,defaultConfigurationName='Release')
target=obj('target','PBXNativeTarget',buildConfigurationList=configLists['app'],buildPhases=[sourcePhase,frameworkPhase,resourcePhase],buildRules=[],dependencies=[],name='QiCanIScreenwrite',packageProductDependencies=[product],productName='QiCanIScreenwrite',productReference=appProduct,productType='com.apple.product-type.application')
projectId=obj('project','PBXProject',attributes={'BuildIndependentTargetsInParallel':'YES','LastUpgradeCheck':'2700'},buildConfigurationList=configLists['project'],compatibilityVersion='Xcode 14.0',developmentRegion='en',hasScannedForEncodings=0,knownRegions=['en','Base'],mainGroup=main,packageReferences=[package],productRefGroup=products,projectDirPath='',projectRoot='',targets=[target])
def encode(value,level=0):
 pad='\t'*level
 if isinstance(value,dict):return '{\n'+''.join(pad+'\t'+json.dumps(str(k))+' = '+encode(v,level+1)+';\n' for k,v in value.items())+pad+'}'
 if isinstance(value,list):return '(\n'+''.join(pad+'\t'+encode(v,level+1)+',\n' for v in value)+pad+')'
 if isinstance(value,int):return str(value)
 return json.dumps(value)
(project/'project.pbxproj').write_text('// !$*UTF8*$!\n'+encode({'archiveVersion':1,'classes':{},'objectVersion':56,'objects':objects,'rootObject':projectId})+'\n')
scheme=project/'xcshareddata/xcschemes';scheme.mkdir(parents=True,exist_ok=True)
ref=f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="QiCanIScreenwrite.app" BlueprintName="QiCanIScreenwrite" ReferencedContainer="container:QiCanIScreenwrite.xcodeproj"/>'
(scheme/'QiCanIScreenwrite.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables/></TestAction><LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></LaunchAction><ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>''')
print(f'Generated {project} with {len(sources)} app Swift files.')
