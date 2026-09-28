#!/usr/bin/env python3
"""Create a disposable UI-test project without rewriting local signing settings."""
from pathlib import Path
import hashlib, json, subprocess, sys
root = Path(__file__).resolve().parents[1]
destination = Path(sys.argv[1] if len(sys.argv) > 1 else '/private/tmp/qicaniscreenwrite-page-ui-project')
project = destination / 'QiCanIScreenwrite.xcodeproj'
project.mkdir(parents=True, exist_ok=True)
data = json.loads(subprocess.check_output(['plutil', '-convert', 'json', '-o', '-', str(root/'QiCanIScreenwrite.xcodeproj/project.pbxproj')]))
objects = data['objects']; main = objects[data['rootObject']]
main['projectDirPath'] = ''
objects[main['mainGroup']]['path'] = str(root)
objects[main['mainGroup']]['sourceTree'] = '<absolute>'
for value in objects.values():
    if value['isa'] == 'XCLocalSwiftPackageReference': value['relativePath'] = str(root/'Core')
    if value['isa'] == 'XCBuildConfiguration':
        settings = value['buildSettings']
        if 'PRODUCT_BUNDLE_IDENTIFIER' in settings:
            settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.hampton.qicaniscreenwrite.pageqa'
            settings['INFOPLIST_FILE'] = str(root/'QiCanIScreenwrite/Info.plist')
def add(key_name, isa, **values):
    key = hashlib.sha256(('page-ui-'+key_name).encode()).hexdigest()[:24].upper()
    objects[key] = dict(isa=isa, **values)
    return key
app = main['targets'][0]
source = add('source', 'PBXFileReference', lastKnownFileType='sourcecode.swift', path=str(root/'UITests/PageWritingUITests.swift'), sourceTree='<absolute>')
build = add('build', 'PBXBuildFile', fileRef=source)
product = add('product', 'PBXFileReference', explicitFileType='wrapper.cfbundle', path='PageWritingUITests.xctest', sourceTree='BUILT_PRODUCTS_DIR')
objects[main['mainGroup']]['children'].append(source)
objects[main['productRefGroup']]['children'].append(product)
sources = add('sources', 'PBXSourcesBuildPhase', buildActionMask=2147483647, files=[build], runOnlyForDeploymentPostprocessing=0)
proxy = add('proxy', 'PBXContainerItemProxy', containerPortal=data['rootObject'], proxyType=1, remoteGlobalIDString=app, remoteInfo='QiCanIScreenwrite')
dependency = add('dependency', 'PBXTargetDependency', target=app, targetProxy=proxy)
configs=[]
for mode in ['Debug','Release']:
    configs.append(add(mode, 'XCBuildConfiguration', name=mode, buildSettings=dict(PRODUCT_NAME='PageWritingUITests',PRODUCT_BUNDLE_IDENTIFIER='com.hampton.qicaniscreenwrite.pageqa.tests',GENERATE_INFOPLIST_FILE='YES',SDKROOT='iphoneos',IPHONEOS_DEPLOYMENT_TARGET='17.0',SWIFT_VERSION='5.0',TARGETED_DEVICE_FAMILY='1',TEST_TARGET_NAME='QiCanIScreenwrite',CODE_SIGN_STYLE='Automatic',LD_RUNPATH_SEARCH_PATHS=['$(inherited)','@executable_path/Frameworks','@loader_path/Frameworks'])))
config = add('configs', 'XCConfigurationList', buildConfigurations=configs, defaultConfigurationIsVisible=0, defaultConfigurationName='Debug')
target = add('target', 'PBXNativeTarget', buildConfigurationList=config, buildPhases=[sources], buildRules=[], dependencies=[dependency], name='PageWritingUITests', productName='PageWritingUITests', productReference=product, productType='com.apple.product-type.bundle.ui-testing')
main['targets'].append(target)
def encode(value, level=0):
    pad='\t'*level
    if isinstance(value,dict): return '{\n'+''.join(pad+'\t'+json.dumps(str(k))+' = '+encode(v,level+1)+';\n' for k,v in value.items())+pad+'}'
    if isinstance(value,list): return '(\n'+''.join(pad+'\t'+encode(v,level+1)+',\n' for v in value)+pad+')'
    if isinstance(value,int): return str(value)
    return json.dumps(value)
(project/'project.pbxproj').write_text('// !$*UTF8*$!\n'+encode(data)+'\n')
scheme=(root/'QiCanIScreenwrite.xcodeproj/xcshareddata/xcschemes/QiCanIScreenwrite.xcscheme').read_text()
testref=f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="PageWritingUITests.xctest" BlueprintName="PageWritingUITests" ReferencedContainer="container:QiCanIScreenwrite.xcodeproj"/>'
scheme=scheme.replace('<Testables/>',f'<Testables><TestableReference skipped="NO">{testref}</TestableReference></Testables>')
folder=project/'xcshareddata/xcschemes'; folder.mkdir(parents=True, exist_ok=True)
(folder/'QiCanIScreenwrite.xcscheme').write_text(scheme)
print(project)
