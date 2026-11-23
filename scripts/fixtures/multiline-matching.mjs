export function multilineMatchingQuestion(allowTargetReuse=false) {
  return {id:'synthetic-multiline-matching',type:'matching-v1',question:'Match the supplied synthetic Python examples.',allowTargetReuse,
    sources:[{id:'source-a',text:'Synthetic source A'},{id:'source-b',text:'Synthetic source B'}],
    targets:[{id:'target-a',text:'if value:\n    print("synthetic")\n    # '+ 'long-code '.repeat(30)},
      {id:'target-b',text:'for value in items:\n\tprint(value)'}]};
}
